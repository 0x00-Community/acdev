import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TEXT = readFileSync(join(import.meta.dir, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')
type Step = { name?: string; uses?: string; with?: Record<string, unknown>; run?: string }
type Job = { permissions?: Record<string, string>; needs?: string; steps: Step[] }
const workflow = Bun.YAML.parse(TEXT) as {
  on: { push: { tags: string[] } } & Record<string, unknown>
  permissions: Record<string, string>
  env: Record<string, string>
  jobs: Record<string, Job>
}
const jobs = workflow.jobs
const runs = (job: string) => jobs[job]!.steps.map((step) => step.run ?? '').join('\n')
const uses = (job: string) => jobs[job]!.steps.map((step) => step.uses).filter((value): value is string => !!value)

describe('release.yml', () => {
  test('runs on v* tags only, with read-only default permissions', () => {
    expect(Object.keys(workflow.on)).toEqual(['push'])
    expect(workflow.on.push.tags).toEqual(['v*'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  test('the jobs run pkgs (the build), then guard, then upload', () => {
    expect(Object.keys(jobs).sort()).toEqual(['guard', 'pkgs', 'upload'])
    expect(jobs['guard']!.needs).toBe('pkgs')
    expect(jobs['upload']!.needs).toBe('guard')
  })

  test('only the upload job can request an OIDC token, and it uses only GitHub-owned actions', () => {
    const withToken = Object.entries(jobs).filter(([, job]) => job.permissions?.['id-token'] === 'write')
    expect(withToken.map(([id]) => id)).toEqual(['upload'])
    expect(uses('upload')).toEqual(['actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333'])
  })

  test('every action is pinned to a full commit SHA with its version noted', () => {
    const all = Object.keys(jobs).flatMap((job) => uses(job))
    expect(all.length).toBeGreaterThan(0)
    for (const action of all) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    expect(TEXT.match(/@[0-9a-f]{40} # v\d+/g)?.length).toBe(all.length)
  })

  test('checkout never keeps the token, in every job that checks out', () => {
    for (const job of Object.keys(jobs)) {
      for (const step of jobs[job]!.steps) {
        if (step.uses?.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials']).toBe(false)
      }
    }
  })

  test('the SDK is the same npm release as the tag, and nothing is downloaded from acdert or acde-dopame', () => {
    expect(workflow.env['SDK_VERSION']).toBe('0.0.5')
    expect(runs('pkgs')).toContain('npm pack "@dopame/acde-api@$SDK_VERSION"')
    expect(runs('pkgs')).toContain('npm has no @dopame/acde-api@$SDK_VERSION')
    expect(TEXT).not.toMatch(/acdert\/latest|acde-dopame\/latest|acde-dopame\/\$|acdert-host|acdert-x86/)
    expect(TEXT).not.toMatch(/\bdopame\.tar\.gz\b/)
  })

  test('the package is one archive with no runtime, host or desktop in it', () => {
    expect(runs('pkgs')).toContain('bun scripts/dist.ts --api')
    expect(runs('pkgs')).not.toMatch(/--acdert|--host|--desktop|--triple/)
    expect(runs('upload')).toContain('echo "$v/acde-$v.tar.gz"')
  })

  test('the upload job uploads an explicit allow-list with no sync, recursion or globs', () => {
    const upload = runs('upload')
    expect(upload).not.toMatch(/\bsync\b|--recursive|\bcp -r\b/)
    expect(upload).not.toMatch(/s3 cp [^\n]*out\/[^\n]*\*/)
    expect(upload).toContain('put "out/$v/acde-$v.tar.gz"')
    expect(upload).toContain('put "out/$v/SHA256SUMS"')
    expect(upload).toContain('put out/latest latest')
    expect(upload).toContain('put out/latest.json latest.json')
    expect(upload).toContain('put out/install.sh install.sh')
    expect(upload).toContain('put out/install.ps1 install.ps1')
  })

  test('the upload job checks the allow-list and the checksums right before it uploads', () => {
    const steps = jobs['upload']!.steps.map((step) => step.name ?? '')
    const check = steps.indexOf('check the allow-list and the checksums once more')
    const credentials = steps.indexOf('credentials from the GitHub OIDC token')
    const upload = steps.indexOf('upload the allow-list, one file at a time')
    expect(check).toBeGreaterThanOrEqual(0)
    expect(check).toBeLessThan(credentials)
    expect(credentials).toBeLessThan(upload)
    expect(runs('upload')).toContain('diff "$expected" actual')
    expect(runs('upload')).toContain('sha256sum -c SHA256SUMS')
  })

  test('the guard job runs the release guard on the artifact before anything is uploaded', () => {
    expect(runs('guard')).toContain('bun scripts/release-guard.ts --dir "$GITHUB_WORKSPACE/out"')
    expect(uses('guard').some((action) => action.startsWith('actions/download-artifact@'))).toBe(true)
    expect(uses('guard').some((action) => action.startsWith('actions/checkout@'))).toBe(true)
    expect(jobs['guard']!.permissions).toBeUndefined()
  })

  test('a published version is never overwritten', () => {
    const upload = runs('upload')
    expect(upload).toContain('aws s3api head-object')
    expect(upload.indexOf('head-object')).toBeLessThan(upload.indexOf('aws s3 cp'))
  })

  test('credentials are masked before they are used, never echoed, and set -x is never used', () => {
    expect(TEXT).not.toContain('secrets.')
    expect(TEXT).not.toMatch(/set -x|bash -x|sh -x/)
    expect(TEXT.indexOf('::add-mask::$token')).toBeLessThan(TEXT.indexOf('assume-role-with-web-identity'))
    expect(TEXT.indexOf('::add-mask::$secret')).toBeLessThan(TEXT.indexOf('AWS_SECRET_ACCESS_KEY=$secret'))
    const printed = TEXT.split('\n').filter((line) => !/add-mask|AWS_/.test(line) && /echo/.test(line))
    expect(printed.filter((line) => /\$(token|secret|session|creds)\b/.test(line))).toEqual([])
  })

  test('the OIDC exchange is done with the AWS CLI, not a third-party action', () => {
    expect(TEXT).not.toContain('aws-actions/')
    expect(runs('upload')).toContain('aws sts assume-role-with-web-identity')
  })

  test('the release role, bucket, prefix, region and distribution are each stated once', () => {
    expect(workflow.env['ROLE']).toBe('arn:aws:iam::312030312811:role/dopame-acde-release')
    expect(workflow.env['AWS_REGION']).toBe('ap-southeast-1')
    expect(workflow.env['CLOUDFRONT_DISTRIBUTION']).toBe('E3ET3L14ALFOXX')
    expect(workflow.env['BUCKET']).toBe('dopame-pkgs')
    expect(workflow.env['PREFIX']).toBe('acde')
    expect(workflow.env['PKGS']).toBe('https://pkgs.dopame.ai')
  })
})
