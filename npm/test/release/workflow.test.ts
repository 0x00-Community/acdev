import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pkgs } from '../../src/pkgs.ts'

const TEXT = readFileSync(join(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')
const CREDENTIALS = 'credentials for the role'
const LOCK = readFileSync(join(import.meta.dir, '..', '..', 'bun.lock'), 'utf8')
type Step = {
  name?: string; id?: string; if?: string; uses?: string; run?: string
  with?: Record<string, unknown>; env?: Record<string, string>
}
type Job = {
  needs?: string | string[]; if?: string; permissions?: Record<string, string>; env?: Record<string, string>
  outputs?: Record<string, string>; steps: Step[]; strategy?: { matrix: { include: Record<string, string>[] } }
}
type Input = { description: string; required: boolean; default: boolean | string; type: string }
const workflow = Bun.YAML.parse(TEXT) as {
  on: { push: { tags: string[] }; workflow_dispatch: { inputs: Record<string, Input> } }
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  env: Record<string, string>
  jobs: Record<string, Job>
}
const jobs = workflow.jobs
const runs = (job: string) => jobs[job]!.steps.map((step) => step.run ?? '').join('\n')
const uses = (job: string) => jobs[job]!.steps.map((step) => step.uses).filter((value): value is string => !!value)
const needs = (job: string) => [jobs[job]!.needs ?? []].flat()
const step = (job: string, name: string) => jobs[job]!.steps.find((item) => item.name === name)
const checkoutOf = (job: string) => jobs[job]!.steps.find((item) => /(^|\/)checkout@/.test(item.uses ?? ''))
const indexIn = (text: string, needle: string) => {
  const at = text.indexOf(needle)
  expect(at).toBeGreaterThanOrEqual(0)
  return at
}

describe('release.yml', () => {
  test('is started by hand, with publish (boolean, default false) and string inputs, or by pushing a tag v*', () => {
    expect(Object.keys(workflow.on)).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on.push).toEqual({ tags: ['v*'] })
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(Object.keys(inputs)).toEqual(['publish', 'commit', 'version', 'skip_targets'])
    for (const name of ['commit', 'version', 'skip_targets']) {
      expect(inputs[name]).toEqual({ description: expect.any(String), required: false, default: '', type: 'string' })
    }
    expect(inputs['publish']).toEqual({ description: expect.any(String), required: false, default: false, type: 'boolean' })
  })

  test('read-only by default; only the tag job writes, and only contents', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const writers = Object.entries(jobs).filter(([, job]) => job.permissions)
    expect(writers.map(([id, job]) => [id, job.permissions])).toEqual([['tag', { contents: 'write' }]])
  })

  test('concurrent releases queue and are never cancelled midway', () => {
    expect(workflow.concurrency).toEqual({ group: 'acdev-release', 'cancel-in-progress': false })
  })

  test('the jobs and their needs', () => {
    expect(Object.keys(jobs)).toEqual(['plan', 'build', 'guest', 'pkgs', 'guard', 'upload', 'npm', 'tag', 'latest'])
    expect(needs('plan')).toEqual([])
    expect(needs('build')).toEqual(['plan'])
    expect(needs('guest')).toEqual(['plan'])
    expect(needs('pkgs')).toEqual(['plan', 'build', 'guest'])
    expect(needs('guard')).toEqual(['plan', 'pkgs'])
    expect(needs('upload')).toEqual(['plan', 'guard'])
    expect(needs('npm')).toEqual(['plan', 'guard'])
    expect(needs('tag')).toEqual(['plan', 'guard', 'upload'])
    expect(needs('latest')).toEqual(['plan', 'guard', 'tag'])
  })

  test('upload, tag and latest need publish=true and the job before them to succeed; npm needs publish=true', () => {
    const gates: Record<string, string> = { upload: 'guard', tag: 'upload', latest: 'tag' }
    for (const [job, dependency] of Object.entries(gates)) {
      expect(jobs[job]!.if).toBe(`needs.plan.outputs.publish == 'true' && needs.${dependency}.result == 'success'`)
    }
    expect(jobs['npm']!.if).toBe("needs.plan.outputs.publish == 'true'")
    expect(TEXT).not.toMatch(/\$\{\{\s*!?inputs\./)
    expect(runs('plan')).toContain('if [ "${PUBLISH_INPUT:-}" = true ]; then PUBLISH=true; else PUBLISH=false; fi')
    expect(jobs['guard']!.if).toBeUndefined()
  })

  test('a skipped target skips its build leg; pkgs goes on unless a build failed', () => {
    expect(jobs['build']!.if).toBe("contains(format(',{0},', needs.plan.outputs.targets), format(',{0},', matrix.triple))")
    expect(jobs['pkgs']!.if).toContain("needs.build.result != 'failure'")
    expect(jobs['pkgs']!.if).toContain("needs.guest.result == 'success'")
  })

  test('the versioned files are uploaded before the tag, and latest.json is updated after the tag', () => {
    const upload = runs('upload')
    expect(indexIn(upload, 'publish_once "$f"')).toBeLessThan(indexIn(upload, 'publish_once SHA256SUMS'))
    expect(upload).toContain('readback')
    expect(upload).toContain('does not read back as uploaded')
    expect(upload).not.toMatch(/latest\.json|install\.sh/)
    expect(runs('tag')).toContain('git push origin "refs/tags/$TAG"')
    const latest = runs('latest')
    const order = ['put install.sh', 'put install.ps1', 'put install.md', 'put latest ', 'put latest.json', 'create-invalidation']
    const at = order.map((needle) => indexIn(latest, needle))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test('a preview (publish=false) says so and stops after the guard', () => {
    expect(step('guard', 'a preview stops here')?.if).toBe("needs.plan.outputs.publish != 'true'")
  })

  test('a publish needs a commit on origin/main; a publish by hand runs only on main; the version', () => {
    const plan = runs('plan')
    expect(plan).toContain('a publish needs a commit: run it with -f commit=<sha>')
    expect(plan).toContain('git rev-parse --verify --quiet "$COMMIT^{commit}"')
    expect(plan).toContain('git merge-base --is-ancestor "$sha" origin/main')
    expect(plan).toContain('[ "$PUBLISH" = true ] && [ -z "$PUSHED_TAG" ] && [ "$GITHUB_REF" != refs/heads/main ]')
    expect(plan).toContain('push:refs/tags/v*) PUBLISH=true; COMMIT=$GITHUB_SHA; PUSHED_TAG=')
    const checkout = indexIn(plan, 'git checkout --quiet --detach "$sha"')
    expect(indexIn(plan, 'git merge-base --is-ancestor')).toBeLessThan(checkout)
    expect(checkout).toBeLessThan(indexIn(plan, 'PUSHED_TAG#v'))
    expect(indexIn(plan, 'PUSHED_TAG#v')).toBeLessThan(indexIn(plan, 'VERSION_INPUT#v'))
    expect(plan).toContain("git tag --list 'v*'")
    expect(plan).toContain('$3 + 1')
    expect(plan).toContain('already exists and points at $tagged, not at $sha')
    expect(jobs['plan']!.outputs).toEqual({
      publish: '${{ steps.version.outputs.publish }}',
      sha: '${{ steps.version.outputs.sha }}',
      libacde: '${{ steps.libacde.outputs.sha }}',
      version: '${{ steps.version.outputs.version }}',
      tag: '${{ steps.version.outputs.tag }}',
      targets: '${{ steps.targets.outputs.targets }}',
    })
  })

  test('the plan checkout fetches history; every later checkout is the resolved commit and only tag keeps a token', () => {
    expect(checkoutOf('plan')?.with?.['fetch-depth']).toBe(0)
    for (const job of ['build', 'guest', 'pkgs', 'guard', 'tag']) {
      expect(checkoutOf(job)?.with?.['ref']).toBe('${{ needs.plan.outputs.sha }}')
    }
    for (const [id, job] of Object.entries(jobs)) {
      for (const item of job.steps) {
        if (/(^|\/)checkout@/.test(item.uses ?? '')) expect(item.with?.['persist-credentials']).toBe(id === 'tag')
      }
    }
  })

  test('the tag job creates an annotated tag on the resolved commit, never moves or forces one', () => {
    const run = runs('tag')
    expect(run).toContain('test "$(git rev-parse HEAD)" = "$SHA"')
    expect(run).toContain('tag -a "$TAG" -m "acdev $TAG" "$SHA"')
    expect(run).toContain('a rerun continues')
    expect(run).not.toMatch(/git tag (?!-a)/)
    expect(run).not.toMatch(/git push[^\n]*(--force|\s-f\b|\+refs)/)
  })

  test('one version: set into Cargo.toml, npm/package.json and the SDK before building and packing', () => {
    expect(runs('build')).toContain('sh acdev/scripts/set-version.sh "${{ needs.plan.outputs.version }}" acdev')
    const pkgs = runs('pkgs')
    expect(indexIn(pkgs, 'set-version.sh "$V" ..')).toBeLessThan(indexIn(pkgs, 'bun scripts/dist.ts'))
    expect(pkgs).toContain('--api "$GITHUB_WORKSPACE/libacde/acde-api" --sdk "$V"')
  })

  test('each target builds acdev and acdevtool and packs acdevrt-<triple> and acdevtools-<triple>; the guest job acdevd', () => {
    expect(jobs['build']!.strategy!.matrix.include.map((leg) => leg['triple'])).toEqual([
      'aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc',
    ])
    const build = runs('build')
    expect(build).toContain('$cargo build --locked --profile dist -p acdev --target ${{ matrix.triple }}')
    expect(build).toContain('(cd crates/tool && $cargo build --locked --release --target ${{ matrix.triple }})')
    expect(build).toContain('pack acdevrt "acdev/target/$t/dist/acdev$x" "acdev$x"')
    expect(build).toContain('pack acdevtools "acdev/crates/tool/target/$t/release/acdevtool$x" "acdevtool$x"')
    expect(jobs['build']!.steps.some((item) => item.uses === './acdev/.github/actions/libacde')).toBe(true)
    const guest = runs('guest')
    expect(guest).toContain('cargo build --locked --release --target $a-unknown-linux-musl')
    expect(guest).toContain('acdev-guest-${{ needs.plan.outputs.version }}.tar.gz')
    const download = jobs['pkgs']!.steps.find((item) => item.uses?.includes('/gitea-download-artifact@'))
    expect(download?.with).toEqual({ path: 'in', pattern: '{build-*,guest}' })
    expect(runs('pkgs')).toContain('cp "$GITHUB_WORKSPACE"/in/*/*.tar.* "$GITHUB_WORKSPACE/shipped/"')
    expect(runs('pkgs')).toContain('--runtime "$GITHUB_WORKSPACE/shipped"')
  })

  test('build has bun 1.4.4 and libacde/js installed before cargo: build.rs bundles libacde/js', () => {
    const items = jobs['build']!.steps
    const bun = items.findIndex((item) => item.uses?.includes('/setup-bun@'))
    const cargo = items.findIndex((item) => (item.run ?? '').includes('--profile dist'))
    expect(bun).toBeGreaterThanOrEqual(0)
    expect(bun).toBeLessThan(cargo)
    expect(items[bun]!.with?.['bun-version']).toBe('1.4.4')
    expect(runs('build')).toContain('bun install --frozen-lockfile --cwd libacde/js')
  })

  test('npm publishes the platform packages and @dopame/acdev, not the private SDK', () => {
    const npm = runs('npm')
    expect(npm).toContain('for dir in npm/acdev-*-* npm/acdev; do')
    expect(npm).toContain('"$rel/acdevrt-$t".tar.* "$rel/acdevtools-$t".tar.*')
    expect(npm).not.toMatch(/acdev-api|acde-api-\*/)
  })

  test('the lockfile fetches every package from the default registry, not a mirror', () => {
    expect(LOCK).not.toContain('mirrors.cloud.tencent.com')
  })

  test('every job runs on the x86_64-debian runners themselves, in no container', () => {
    for (const job of Object.values(jobs)) {
      expect((job as Job & { 'runs-on'?: string })['runs-on']).toBe('x86_64-debian')
      expect((job as Job & { container?: string }).container).toBeUndefined()
    }
  })

  test('the guard checks the exact allow-list before upload; upload and latest check the checksums before S3', () => {
    expect(runs('guard')).toContain('bun ../scripts/release-guard.ts --dir "$GITHUB_WORKSPACE/out"')
    expect(runs('guard')).toContain('--targets "${{ needs.plan.outputs.targets }}"')
    for (const job of ['upload', 'latest']) expect(runs(job)).toContain('sha256sum -c SHA256SUMS')
    const steps = jobs['upload']!.steps.map((item) => item.name ?? '')
    expect(steps.indexOf(CREDENTIALS)).toBeLessThan(steps.indexOf('upload every file SHA256SUMS lists, then SHA256SUMS, each read back'))
    expect(runs('upload')).toContain('*[!A-Za-z0-9._-]*) echo "::error::bad file name $f"')
    expect(runs('latest')).toContain('"/$PREFIX/$V/*"')
  })

  test('upload is file by file, with no sync, recursion or globs', () => {
    for (const job of ['upload', 'latest']) {
      const run = runs(job)
      expect(run).not.toMatch(/\bsync\b|--recursive|\bcp -r\b/)
      expect(run).not.toMatch(/s3 cp [^\n]*\*/)
    }
  })

  test('a published version is identical or refused, never overwritten, and a rerun can continue', () => {
    const upload = runs('upload')
    expect(upload).toContain('aws s3api head-object')
    expect(upload).toContain('cmp -s "$RUNNER_TEMP/published" "$1"')
    expect(upload).toContain('already published, identical')
    expect(upload).toContain('a version is never overwritten')
  })

  test('credentials are masked before they are used, never echoed, and set -x is never used', () => {
    const secrets = [...TEXT.matchAll(/\bsecrets\.(\w+)/g)].map((match) => match[1])
    expect([...new Set(secrets)].sort()).toEqual(['ACKERNEL_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN'])
    for (const job of ['upload', 'latest']) {
      const item = step(job, CREDENTIALS)
      expect(item?.env).toEqual({ KEY_ID: '${{ secrets.AWS_ACCESS_KEY_ID }}', KEY_SECRET: '${{ secrets.AWS_SECRET_ACCESS_KEY }}' })
      expect(indexIn(item!.run!, '::add-mask::')).toBeLessThan(indexIn(item!.run!, '>> "$GITHUB_ENV"'))
      expect(item!.run).toContain('aws sts assume-role --role-arn "$ROLE"')
    }
    expect(TEXT).not.toMatch(/set -x|bash -x|sh -x|aws-actions\//)
    const printed = TEXT.split('\n').filter((line) => /echo|printf/.test(line) && !/add-mask|\| jq |>> "\$GITHUB_ENV"/.test(line))
    expect(printed.filter((line) => /\$(token|secret|session|creds|KEY_ID|KEY_SECRET)\b/.test(line))).toEqual([])
  })

  test('no job prepares the same remote action twice (act_runner fails the second)', () => {
    for (const job of Object.keys(jobs)) {
      const remote = uses(job).filter((action) => !action.startsWith('./'))
      expect(new Set(remote).size, job).toBe(remote.length)
    }
  })

  test('every remote action is pinned to a full commit SHA with its version noted', () => {
    const all = Object.keys(jobs).flatMap((job) => uses(job)).filter((action) => !action.startsWith('./'))
    expect(all.length).toBeGreaterThan(0)
    for (const action of all) expect(action).toMatch(/^http:\/\/gitea\.dopamine\/mirror\/[\w.-]+@[0-9a-f]{40}$/)
    expect(TEXT.match(/@[0-9a-f]{40} # v\d+/g)?.length).toBe(all.length)
  })

  test('the release role, bucket, prefix, region, distribution and PKGS are each stated once', () => {
    expect(workflow.env).toEqual({
      PKGS: 'https://pkgs.dopame.ai',
      AWS_REGION: 'ap-southeast-1',
      ROLE: 'arn:aws:iam::312030312811:role/dopame-acde-release',
      BUCKET: 'dopame-pkgs',
      PREFIX: 'acdev',
      CLOUDFRONT_DISTRIBUTION: 'E3ET3L14ALFOXX',
    })
    expect(Pkgs.BASE).toBe(workflow.env['PKGS']!)
    expect(Pkgs.ACDEV).toBe(`${workflow.env['PKGS']}/${workflow.env['PREFIX']}`)
  })
})
