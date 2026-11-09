import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TEXT = readFileSync(join(import.meta.dir, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')
type Step = { name?: string; uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, string> }
type Job = { 'runs-on'?: string; permissions?: Record<string, string>; needs?: string | string[]; steps: Step[] }
const workflow = Bun.YAML.parse(TEXT) as {
  on: { push: { tags: string[] } } & Record<string, unknown>
  permissions: Record<string, string>
  env: Record<string, string>
  jobs: Record<string, Job>
}

describe('release.yml', () => {
  test('runs on v* tags only, with read-only default permissions', () => {
    expect(Object.keys(workflow.on)).toEqual(['push'])
    expect(workflow.on.push.tags).toEqual(['v*'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  test('only the upload job can request an OIDC token, and it uses only GitHub-owned actions', () => {
    const withToken = Object.entries(workflow.jobs).filter(([, job]) => job.permissions?.['id-token'] === 'write')
    expect(withToken.map(([id]) => id)).toEqual(['upload'])
    const uses = workflow.jobs['upload']!.steps.map((step) => step.uses).filter((value): value is string => !!value)
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action).toMatch(/^actions\/[\w-]+@v\d+$/)
  })

  test('every other job keeps the token read-only, and the build cannot publish', () => {
    expect(workflow.jobs['build']!.permissions).toBeUndefined()
    expect(workflow.jobs['build']!.steps.some((step) => /aws /.test(step.run ?? ''))).toBe(false)
    expect(workflow.jobs['upload']!.needs).toBe('build')
  })

  test('actions are pinned to a major version and checkout does not keep the token', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@v\d+$/)
      }
    }
    const checkout = workflow.jobs['build']!.steps.find((step) => step.uses?.startsWith('actions/checkout'))
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  })

  test('the role, bucket, prefix, and distribution are in one place each', () => {
    expect(workflow.env['RELEASE_ROLE_ARN']).toMatch(/^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/)
    expect(workflow.env['CLOUDFRONT_DISTRIBUTION']).toBe('E3ET3L14ALFOXX')
    expect(workflow.env['PKGS_BUCKET']).toBe('dopame-pkgs')
    expect(workflow.env['PKGS_PREFIX']).toBe('acde')
    expect(TEXT.match(/RELEASE_ROLE_ARN/g)?.length).toBe(2)
  })

  test('no repository secrets are read, and the OIDC token is masked before use', () => {
    expect(TEXT).not.toContain('secrets.')
    expect(TEXT.indexOf('::add-mask::$token')).toBeLessThan(TEXT.indexOf('assume-role-with-web-identity'))
  })

  test('the build job is ordered before the upload job and checks the tag against the version', () => {
    const build = workflow.jobs['build']!
    expect(build.steps.some((step) => /v\$version" != "\$GITHUB_REF_NAME/.test(step.run ?? ''))).toBe(true)
    expect(build.steps.map((step) => step.name ?? '').join('|')).toContain('acdert release from pkgs')
  })
})
