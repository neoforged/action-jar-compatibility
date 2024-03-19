import { getOcto } from './utils'
import { context } from '@actions/github'
import { PullRequest } from './types'
import { GitHub } from '@actions/github/lib/utils'
import { CheckRun } from './check_runs'
import * as core from '@actions/core'
import axios from 'axios'
import process from 'process'
import JSZip from 'jszip'
import { getInput } from '@actions/core'

export async function run() {
  const octo = getOcto()

  const workflow_run = context.payload.workflow_run as WorkflowRun

  // Step 1
  if (workflow_run.conclusion != 'success') {
    console.log('Aborting, workflow run was not successful')
    return
  }

  if (workflow_run.event != 'pull_request') {
    console.log(
      `Aborting, only events of type 'pull_request' can trigger publishing`
    )
    return
  }

  if (!workflow_run.head_branch) {
    console.log(`Unknown head branch...`)
    return
  }

  console.log(
    `Workflow run head branch: ${workflow_run.head_branch} and repository owner: ${workflow_run.head_repository.owner.login}`
  )
  const linked = await getLinkedPR(
    octo,
    workflow_run.head_repository,
    workflow_run.head_branch
  )
  if (!linked) {
    console.log(`No open PR associated found...`)
    return
  }
  console.log(`Found associated PR: ${linked}`)

  await runPR(
    octo,
    await octo.rest.pulls
      .get({
        ...context.repo,
        pull_number: linked
      })
      .then(d => d.data),
    workflow_run.id
  )
}

async function getLinkedPR(
  octo: InstanceType<typeof GitHub>,
  repo: Repository,
  head: string
): Promise<number | undefined> {
  const headLabel = repo.owner.login + ':' + head
  if (repo.name != context.repo.repo) {
    for await (const prs of octo.paginate.iterator(octo.rest.pulls.list, {
      ...context.repo,
      state: 'open',
      per_page: 100
    })) {
      const pr = prs.data.find(p => p.head.label == headLabel)
      if (pr) {
        return pr.number
      }
      return undefined
    }
  } else {
    // This is the ideal and efficient solution, but it only works if the base and head repo names are identical
    const possiblePrs = await octo.rest.pulls
      .list({
        ...context.repo,
        head: headLabel,
        state: 'open',
        sort: 'long-running'
      })
      .then(d => d.data)
    if (possiblePrs.length < 1) {
      console.log(`No open PR associated...`)
      return undefined
    }
    return possiblePrs[0].number
  }
}

export async function runPR(
  octo: InstanceType<typeof GitHub>,
  pr: PullRequest,
  runId: number
) {
  const check = new CheckRun(octo, pr)

  try {
    await check.start()

    const artifact = await octo.rest.actions
      .listWorkflowRunArtifacts({
        ...context.repo,
        run_id: runId
      })
      .then(art => art.data.artifacts.find(ar => ar.name == 'jcc'))
    if (!artifact) {
      await check.skipped('No JCC output was found')
      console.log(`Found no JCC artifact`)
      return
    }

    console.log(
      `Found artifact ${artifact!!.id}: ${artifact!!.archive_download_url}`
    )

    const response = await axios.get(artifact!!.archive_download_url, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${process.env['GITHUB_TOKEN']!}`
      }
    })

    const zip = await JSZip.loadAsync(response.data)

    const jccJson = JSON.parse(await zip.file('jcc.json')?.async('string')!!)

    const statuses = await axios.get(
      `https://api.github.com/repos/${pr.base.repo.full_name}/statuses/${pr.base.sha}`,
      {
        responseType: 'json',
        headers: {
          Authorization: `Bearer ${process.env['GITHUB_TOKEN']!}`
        }
      }
    )

    const status = (statuses.data as any[]).find(status =>
      status.description.startsWith('Version: ')
    )
    if (!status) {
      await check.skipped(
        'Could not determine the version the PR was built against'
      )
      console.log(`Could not determine the version the PR was built against`)
      return
    }

    const lastVersion = status.description.substring('Version: '.length)
    console.log(`PR built against ${lastVersion}`)

    const isBeta = new RegExp(getInput('beta-version-pattern')).test(
      lastVersion
    )

    let isBreaking = false
    let message = ``
    Object.keys(jccJson).forEach(project => {
      const incompats = jccJson[project]
      if (Object.keys(incompats).length === 0) {
        return
      }
      message += `\n## \`${project}\`\n`
      Object.keys(incompats).forEach(clazz => {
        const ci = incompats[clazz]
        message += `  - \`${clazz}\`\n`
        ci.classIncompatibilities.forEach((cli: any) => {
          message += `    * ${getEmoji(cli)} \`${cli.message}\`\n`
          if (cli.isError) isBreaking = true
        })
        Object.keys(ci.methodIncompatibilities).forEach(method => {
          message += `    * \`${method}\`: `
          const messages: string[] = []
          ci.methodIncompatibilities[method].forEach((inc: any) => {
            messages.push(`${getEmoji(inc)} ${inc.message}`)
            if (inc.isError) isBreaking = true
          })
          message += messages.join('; ') + '\n'
        })
        Object.keys(ci.fieldIncompatibilities).forEach(field => {
          message += `    * \`${field}\`: `
          const messages: string[] = []
          ci.fieldIncompatibilities[field].forEach((inc: any) => {
            messages.push(`${getEmoji(inc)} ${inc.message}`)
            if (inc.isError) isBreaking = true
          })
          message += messages.join('; ') + '\n'
        })
      })
    })

    const selfComment = await getSelfComment(octo, pr.number)
    if (message && isBreaking) {
      message =
        `@${pr.user.login}, this PR introduces breaking changes.\n${
          isBeta
            ? `Fortunately, this project is currently accepting breaking changes, but if they are not intentional, please revert them.`
            : `Unfortunately, this project is not accepting breaking changes right now. \nPlease revert them before this PR can be merged.`
        }\n` + message
      let commentUrl = selfComment?.html_url
      if (selfComment) {
        await octo.rest.issues.updateComment({
          ...context.repo,
          comment_id: selfComment.id,
          body: message
        })
      } else {
        const res = await octo.rest.issues.createComment({
          ...context.repo,
          issue_number: pr.number,
          body: message
        })
        commentUrl = res.data.html_url
      }

      if (isBeta) {
        await check.succeed(
          commentUrl,
          'PR introduces breaking changes, but the project currently accepts breaking changes'
        )
      } else {
        await check.failed(commentUrl, 'PR introduces breaking changes')
      }
    } else {
      if (selfComment) {
        await octo.rest.issues.deleteComment({
          ...context.repo,
          comment_id: selfComment.id
        })
      }

      await check.succeed(undefined, 'PR does not introduce breaking changes')
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) {
      await check.error(error)
      console.log(`Error: ${error.message}`)
      console.log(error.stack)
      core.setFailed(error.message)
    }
  }
}

function getEmoji(obj: any): string {
  return obj.isError ? '❗' : '⚠'
}

interface WorkflowRun {
  id: number
  conclusion: 'success' | 'failure'
  head_branch: string | undefined
  pull_requests: {
    number: number
  }[]
  head_repository: Repository
  head_sha: string
  event: string
}

interface Repository {
  owner: {
    login: string
  }
  name: string
}

interface Comment {
  id: number
  body?: string | undefined
  html_url: string
}

async function getSelfComment(
  octo: InstanceType<typeof GitHub>,
  prNumber: number
): Promise<Comment | undefined> {
  const self = getInput('self-name')

  for await (const comments of octo.paginate.iterator(
    octo.rest.issues.listComments,
    {
      ...context.repo,
      issue_number: prNumber
    }
  )) {
    for (const comment of comments.data) {
      if (comment.user!.login == self) {
        return comment
      }
    }
  }
  return undefined
}
