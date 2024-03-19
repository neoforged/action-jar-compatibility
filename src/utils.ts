import { getOctokit } from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'
import process from 'process'

export function getOcto(): InstanceType<typeof GitHub> {
  return getOctokit(process.env['GITHUB_TOKEN']!)
}

export function getRunURL(): string {
  return `${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`
}
