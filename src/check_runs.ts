import { GitHub } from '@actions/github/lib/utils'
import { PullRequest } from './types'
import { context } from '@actions/github'
import { getRunURL } from './utils'

export class CheckRun {
  private readonly octo: InstanceType<typeof GitHub>
  private readonly reference: string
  private id: number = 0
  public constructor(octo: InstanceType<typeof GitHub>, pr: PullRequest) {
    this.octo = octo
    this.reference = pr.head.sha
  }

  public async start() {
    this.id = (
      await this.octo.rest.checks.create({
        ...context.repo,
        head_sha: this.reference,
        name: 'Compatibility checks',
        status: 'in_progress',
        details_url: getRunURL()
      })
    ).data.id
  }

  public async skipped(reason: string) {
    await this.octo.rest.checks.update({
      ...context.repo,
      check_run_id: this.id,
      conclusion: 'skipped',
      output: {
        title: 'Compatibility checks skipped',
        summary: reason
      }
    })
  }

  public async failed(url: string | undefined, message: string) {
    await this.octo.rest.checks.update({
      ...context.repo,
      check_run_id: this.id,
      conclusion: 'failure',
      output: {
        title: 'PR introduces breaking changes',
        summary: message
      },
      details_url: url
    })
  }

  public async error(err: Error) {
    await this.octo.rest.checks.update({
      ...context.repo,
      check_run_id: this.id,
      conclusion: 'failure',
      output: {
        title: 'Compatibility checks failed during execution',
        summary: `Compatibility checks failed: ${err}`
      },
      details_url: getRunURL()
    })
  }

  public async succeed(deploymentUrl: string | undefined, message: string) {
    await this.octo.rest.checks.update({
      ...context.repo,
      check_run_id: this.id,
      details_url: deploymentUrl,
      conclusion: 'success',
      output: {
        title: `Compatibility checks succeeded`,
        summary: message,
        text: message
      }
    })
  }
}
