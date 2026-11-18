import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pkgs } from '../../src/pkgs.ts'

const GITHUB = join(import.meta.dir, '..', '..', '..', '.github')
const TEXT = readFileSync(join(GITHUB, 'workflows', 'cicd.yaml'), 'utf8')
const TEST = readFileSync(join(GITHUB, 'workflows', 'test.yml'), 'utf8')
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

describe('cicd.yaml', () => {
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

  test('read-only by default; only the publish job writes, and only contents', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const writers = Object.entries(jobs).filter(([, job]) => job.permissions)
    expect(writers.map(([id, job]) => [id, job.permissions])).toEqual([['publish', { contents: 'write' }]])
  })

  test('concurrent releases queue and are never cancelled midway', () => {
    expect(workflow.concurrency).toEqual({ group: 'acdev-release', 'cancel-in-progress': false })
  })

  test('the jobs and their needs; publish needs publish=true and pkgs to succeed', () => {
    expect(Object.keys(jobs)).toEqual(['plan', 'build', 'guest', 'pkgs', 'publish'])
    expect(needs('plan')).toEqual([])
    expect(needs('build')).toEqual(['plan'])
    expect(needs('guest')).toEqual(['plan'])
    expect(needs('pkgs')).toEqual(['plan', 'build', 'guest'])
    expect(needs('publish')).toEqual(['plan', 'pkgs'])
    expect(jobs['publish']!.if).toBe("needs.plan.outputs.publish == 'true' && needs.pkgs.result == 'success'")
    expect(TEXT).not.toMatch(/\$\{\{\s*!?inputs\./)
    expect(runs('plan')).toContain('if [ "${PUBLISH_INPUT:-}" = true ]; then PUBLISH=true; else PUBLISH=false; fi')
  })

  test('a skipped target skips its build leg; pkgs goes on unless a build failed', () => {
    expect(jobs['build']!.if).toBe("contains(format(',{0},', needs.plan.outputs.targets), format(',{0},', matrix.triple))")
    expect(jobs['pkgs']!.if).toContain("needs.build.result != 'failure'")
    expect(jobs['pkgs']!.if).toContain("needs.guest.result == 'success'")
  })

  test('S3 gets the versioned files, then the tag is pushed, then the pointers and the CDN, then npm', () => {
    const run = runs('publish')
    const order = ['publish_once "$f"', 'publish_once SHA256SUMS', 'git push origin "refs/tags/$TAG"', 'put install.sh', 'put install.ps1',
      'put install.md', 'put latest ', 'put latest.json', 'create-invalidation', 'npm publish']
    const at = order.map((needle) => indexIn(run, needle))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(run).toContain('does not read back as uploaded')
    const names = jobs['publish']!.steps.map((item) => item.name ?? '')
    expect(names.filter((name) => name === CREDENTIALS)).toHaveLength(2)
    expect(names.indexOf(CREDENTIALS)).toBeLessThan(names.indexOf('upload every file SHA256SUMS lists, then SHA256SUMS, each read back'))
    expect(names.lastIndexOf(CREDENTIALS)).toBe(names.indexOf('the pointers, latest.json last, then the CDN') - 1)
  })

  test('a preview (publish=false) says so after the guard', () => {
    const pkgs = runs('pkgs')
    expect(indexIn(pkgs, 'release-guard.ts')).toBeLessThan(indexIn(pkgs, 'preview only'))
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
    const outputs = ['publish', 'sha', 'libacde', 'version', 'tag', 'targets']
    expect(jobs['plan']!.outputs).toEqual(Object.fromEntries(outputs.map((name) => [name, `\${{ steps.version.outputs.${name} }}`])))
  })

  test('the plan checkout fetches history; every later checkout is the resolved commit and only publish keeps a token', () => {
    expect(checkoutOf('plan')?.with?.['fetch-depth']).toBe(0)
    for (const job of ['build', 'guest', 'pkgs', 'publish']) {
      expect(checkoutOf(job)?.with?.['ref']).toBe('${{ needs.plan.outputs.sha }}')
    }
    for (const [id, job] of Object.entries(jobs)) {
      for (const item of job.steps) {
        if (/(^|\/)checkout@/.test(item.uses ?? '')) expect(item.with?.['persist-credentials']).toBe(id === 'publish')
      }
    }
  })

  test('the tag is annotated, on the resolved commit, never moved or forced', () => {
    const run = runs('publish')
    expect(run).toContain('test "$(git rev-parse HEAD)" = "$SHA"')
    expect(run).toContain('tag -a "$TAG" -m "acdev $TAG" "$SHA"')
    expect(run).toContain('a rerun continues')
    expect(run).not.toMatch(/git tag (?!-a)/)
    expect(run).not.toMatch(/git push[^\n]*(--force|\s-f\b|\+refs)/)
  })

  test('one version: set into Cargo.toml, npm/package.json and the SDK before building and packing', () => {
    expect(indexIn(runs('build'), 'sh scripts/set-version.sh "$V" .')).toBeLessThan(indexIn(runs('build'), '--profile dist'))
    expect(jobs['build']!.env?.['V']).toBe('${{ needs.plan.outputs.version }}')
    const pkgs = runs('pkgs')
    expect(indexIn(pkgs, 'set-version.sh "$V" ..')).toBeLessThan(indexIn(pkgs, 'bun scripts/dist.ts'))
    expect(pkgs).toContain('--api "$w/libacde/acde-api" --sdk "$V"')
  })

  test('each target builds acdev and acdevtool and packs acdevrt-<triple> and acdevtools-<triple>; the guest job acdevd', () => {
    expect(jobs['build']!.strategy!.matrix.include.map((leg) => [leg['triple'], leg['cargo'], leg['runner']])).toEqual([
      ['aarch64-apple-darwin', 'zigbuild', 'aarch64-debian'], ['x86_64-apple-darwin', 'zigbuild', 'x86_64-debian'],
      ['x86_64-unknown-linux-gnu', 'build', 'x86_64-debian'], ['x86_64-pc-windows-msvc', 'xwin build', 'x86_64-debian'],
    ])
    const build = runs('build')
    expect(build).toContain('cargo ${{ matrix.cargo }} --locked --profile dist -p acdev --target $T')
    expect(build).toContain('(cd crates/tool && cargo ${{ matrix.cargo }} --locked --release --target $T)')
    expect(build).toContain('pack acdevrt "acdev/target/$T/dist/acdev$x" "acdev$x"')
    expect(build).toContain('pack acdevtools "acdev/crates/tool/target/$T/release/acdevtool$x" "acdevtool$x"')
    expect(build).toContain('SDKROOT=/opt/cross/MacOSX15.5.sdk')
    expect(build).toContain('XWIN_CACHE_DIR=$HOME/.cache/cargo-xwin-atl')
    expect(indexIn(build, 'bun install --frozen-lockfile --cwd ../libacde/js')).toBeLessThan(indexIn(build, '--profile dist'))
    for (const job of ['build', 'pkgs']) expect(jobs[job]!.steps.some((item) => item.name?.startsWith('libacde beside acdev')), job).toBe(true)
    const guest = runs('guest')
    expect(guest).toContain('cargo build --locked --release --target $a-unknown-linux-musl')
    expect(guest).toContain('acdev-guest-${{ needs.plan.outputs.version }}.tar.gz')
    expect(runs('pkgs')).toContain('cp "$w"/in/*/*.tar.* "$w/shipped/"')
    expect(runs('pkgs')).toContain('--runtime "$w/shipped"')
  })

  test('the toolchains are the runner\'s (scripts/runner-setup.sh): no job installs or sets up anything', () => {
    expect(existsSync(join(GITHUB, '..', 'scripts', 'runner-setup.sh'))).toBe(true)
    expect(TEXT + TEST).not.toMatch(/apt-get|setup-bun|rust-toolchain@|rust-cache@|rustup |curl [^\n]*(zig|xwin|zigbuild|sdk)/i)
    for (const text of [TEXT, TEST]) expect((Bun.YAML.parse(text) as { env: Record<string, string> }).env['RUSTUP_HOME']).toBe('/opt/rust/rustup')
    expect(TEXT + TEST).not.toContain('RUNNER_TEMP/home')
  })

  test('npm publishes the platform packages and @dopame/acdev, not the private SDK', () => {
    const npm = step('publish', 'npm (platforms, then @dopame/acdev)')!.run!
    expect(npm).toContain('for dir in npm/acdev-*-* npm/acdev; do')
    expect(npm).toContain('"$rel/acdevrt-$t".tar.* "$rel/acdevtools-$t".tar.*')
    expect(npm).not.toMatch(/acdev-api|acde-api-\*/)
  })

  test('the lockfile fetches every package from the default registry, not a mirror', () => {
    expect(LOCK).not.toContain('mirrors.cloud.tencent.com')
  })

  test('every job runs on the x86_64-debian runners themselves, in no container; Apple silicon on aarch64-debian', () => {
    for (const [id, job] of Object.entries(jobs)) {
      expect((job as Job & { 'runs-on'?: string })['runs-on']).toBe(id === 'build' ? '${{ matrix.runner }}' : 'x86_64-debian')
      expect((job as Job & { container?: string }).container).toBeUndefined()
    }
  })

  test('the guard checks the exact allow-list; publish checks the checksums before S3', () => {
    const pkgs = runs('pkgs')
    expect(pkgs).toContain('bun ../scripts/release-guard.ts --dir "$GITHUB_WORKSPACE/out" --version "$V" --targets "$TARGETS"')
    expect(indexIn(pkgs, 'release-guard.ts')).toBeLessThan(indexIn(pkgs, 'run/latest "$TO:"'))
    const publish = runs('publish')
    expect(indexIn(publish, 'sha256sum -c SHA256SUMS')).toBeLessThan(indexIn(publish, 'publish_once "$f"'))
    expect(publish).toContain('*[!A-Za-z0-9._-]*) echo "::error::bad file name $f"')
    expect(publish).toContain('"/$PREFIX/$V/*"')
  })

  test('S3 is written file by file, with no sync, recursion or globs', () => {
    const run = runs('publish')
    expect(run).not.toMatch(/\bs3 sync\b|--recursive|\bcp -r\b/)
    expect(run).not.toMatch(/s3 cp [^\n]*\*/)
  })

  test('a published version is identical or refused, never overwritten, and a rerun can continue', () => {
    const run = runs('publish')
    expect(run).toContain('aws s3api head-object')
    expect(run).toContain('cmp -s "$RUNNER_TEMP/published" "$1"')
    expect(run).toContain('already published, identical')
    expect(run).toContain('a version is never overwritten')
  })

  test('credentials are masked before they are used, never echoed, and set -x is never used', () => {
    const secrets = [...TEXT.matchAll(/\bsecrets\.(\w+)/g)].map((match) => match[1])
    expect([...new Set(secrets)].sort()).toEqual(['ACKERNEL_TOKEN', 'ARTIFACTS_UPLOAD_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN'])
    const item = step('publish', CREDENTIALS)
    expect(item?.env).toEqual({ KEY_ID: '${{ secrets.AWS_ACCESS_KEY_ID }}', KEY_SECRET: '${{ secrets.AWS_SECRET_ACCESS_KEY }}' })
    expect(indexIn(item!.run!, '::add-mask::')).toBeLessThan(indexIn(item!.run!, '>> "$GITHUB_ENV"'))
    expect(item!.run).toContain('aws sts assume-role --role-arn "$ROLE"')
    expect(TEXT + TEST).not.toMatch(/set -x|bash -x|sh -x|aws-actions\//)
    const printed = TEXT.split('\n').filter((line) => /echo|printf/.test(line) && !/add-mask|\| jq |>> "\$GITHUB_ENV"|> "\$k\/key"/.test(line))
    expect(printed.filter((line) => /\$(token|secret|session|creds|KEY_ID|KEY_SECRET|KEY)\b/.test(line))).toEqual([])
  })

  test('no .github/actions: the workflows say every step, the shared ones anchored once per file', () => {
    expect(existsSync(join(GITHUB, 'actions'))).toBe(false)
    expect(TEXT + TEST).not.toContain('.github/actions')
    for (const anchor of ['&checkout', '&libacde', '&ssh', '&aws']) expect(TEXT.split(anchor).length - 1, anchor).toBe(1)
    for (const anchor of ['&checkout', '&cleanup', '&libacde', '&fetch', '&runtime', '&ssh', '&wpt']) {
      expect(TEST.split(anchor).length - 1, anchor).toBe(1)
    }
    expect(TEST).toContain('[ ! -d "${p%%/hostexecutor/*}" ]')
  })

  test('every job\'s output goes to the artifacts host: rsync over ssh with a write-only key, read back with nc + tar', () => {
    expect(workflow.env['TO']).toBe('artifacts@192.168.10.127')
    expect(workflow.env['PULL']).toBe('192.168.10.127 9127')
    expect(TEXT + TEST).not.toMatch(/gitea-(upload|download)-artifact/)
    for (const text of [TEXT, TEST]) {
      expect(text).toContain('KEY: ${{ secrets.ARTIFACTS_UPLOAD_KEY }}')
      expect(text).toContain('192.168.10.127 ssh-ed25519 ')
    }
    expect(runs('build')).toContain('out/ "$TO:$GITHUB_RUN_NUMBER/build-$T/"')
    expect(runs('guest')).toContain('"$o/" "$TO:$GITHUB_RUN_NUMBER/guest/"')
    expect(runs('pkgs')).toContain('out/ "$TO:$GITHUB_RUN_NUMBER/acdev-release/"')
    expect(runs('pkgs')).toContain('nc $PULL | tar -x')
    expect(runs('publish')).toContain("printf 'acdev/%s/acdev-release\\n' \"$GITHUB_RUN_NUMBER\" | nc $PULL | tar -x")
    for (const line of (TEXT + TEST).split('\n').filter((line) => /^\s*(\[[^\n]*\|\| )?rsync /.test(line) && line.includes('$TO:') && !line.includes('"$TO:"'))) {
      expect(line).toContain('--mkpath')
    }
    expect(TEXT + TEST).not.toMatch(/rsync[^\n]*--delete|\$TO:[^\n"]*\/[A-Za-z.]+"$/m)
  })

  test('every remote action is pinned to a full commit SHA with its version noted', () => {
    const all = Object.keys(jobs).flatMap((job) => uses(job)).filter((action) => !action.startsWith('./'))
    expect(all.length).toBeGreaterThan(0)
    for (const action of all) expect(action).toMatch(/^http:\/\/gitea\.dopamine\/mirror\/[\w.-]+@[0-9a-f]{40}$/)
    expect(TEXT.match(/@[0-9a-f]{40}(?! # v\d+)/g)).toBeNull()
  })

  test('the release role, bucket, prefix, region, distribution and PKGS are each stated once', () => {
    expect(workflow.env).toEqual({
      PKGS: 'https://pkgs.dopame.ai',
      AWS_REGION: 'ap-southeast-1',
      ROLE: 'arn:aws:iam::312030312811:role/dopame-acde-release',
      BUCKET: 'dopame-pkgs',
      PREFIX: 'acdev',
      CLOUDFRONT_DISTRIBUTION: 'E3ET3L14ALFOXX',
      AWS_RETRY_MODE: 'standard',
      AWS_MAX_ATTEMPTS: '10',
      RUSTUP_HOME: '/opt/rust/rustup',
      CARGO_INCREMENTAL: '0',
      CARGO_TERM_COLOR: 'always',
      GIT_TERMINAL_PROMPT: '0',
      TO: 'artifacts@192.168.10.127',
      PULL: '192.168.10.127 9127',
    })
    expect(Pkgs.BASE).toBe(workflow.env['PKGS']!)
    expect(Pkgs.ACDEV).toBe(`${workflow.env['PKGS']}/${workflow.env['PREFIX']}`)
  })
})
