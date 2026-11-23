import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pkgs } from '../../src/pkgs.ts'

const GITHUB = join(import.meta.dir, '..', '..', '..', '.github')
const read = (name: string) => readFileSync(join(GITHUB, 'workflows', name), 'utf8')
const BUILD = read('build.yaml')
const TEST = read('test.yaml')
const TAG = read('tag.yaml')
const RELEASE = read('release.yaml')
const ALL = BUILD + TEST + TAG + RELEASE
const KEYS = {
  R2_ACCOUNT_ID: '${{ secrets.R2_ACCOUNT_ID }}',
  R2_ACCESS_KEY_ID: '${{ secrets.R2_ACCESS_KEY_ID }}',
  R2_SECRET_ACCESS_KEY: '${{ secrets.R2_SECRET_ACCESS_KEY }}',
}
const LOCK = readFileSync(join(import.meta.dir, '..', '..', 'bun.lock'), 'utf8')
type Step = {
  name?: string; id?: string; if?: string; uses?: string; run?: string
  with?: Record<string, unknown>; env?: Record<string, string>; 'working-directory'?: string
}
type Job = {
  needs?: string | string[]; if?: string; permissions?: Record<string, string>; env?: Record<string, string>
  outputs?: Record<string, string>; steps: Step[]; strategy?: { matrix: { include: Record<string, string>[] } }
  uses?: string; with?: Record<string, unknown>; secrets?: string; 'runs-on'?: string; container?: string
}
type Input = { description: string; required: boolean; default?: boolean | string; type: string; options?: string[] }
type Workflow = {
  on: Record<string, { inputs?: Record<string, Input>; outputs?: Record<string, { value: string }>; branches?: string[] } | null>
  permissions?: Record<string, string>
  concurrency?: { group: string; 'cancel-in-progress': boolean }
  env: Record<string, string>
  jobs: Record<string, Job>
}
const parse = (text: string) => Bun.YAML.parse(text) as Workflow
const build = parse(BUILD)
const tests = parse(TEST)
const tag = parse(TAG)
const release = parse(RELEASE)
const steps = (wf: Workflow, job: string) => wf.jobs[job]!.steps
const runs = (wf: Workflow, job: string) => steps(wf, job).map((step) => step.run ?? '').join('\n')
const needs = (wf: Workflow, job: string) => [wf.jobs[job]!.needs ?? []].flat()
const step = (wf: Workflow, job: string, name: string) => steps(wf, job).find((item) => item.name === name)
const checkoutOf = (wf: Workflow, job: string) => steps(wf, job).find((item) => /(^|\/)checkout@/.test(item.uses ?? ''))
const indexIn = (text: string, needle: string) => {
  const at = text.indexOf(needle)
  expect(at).toBeGreaterThanOrEqual(0)
  return at
}
const UPLOAD = 'upload every file SHA256SUMS lists, then SHA256SUMS, each read back'
const POINTERS = 'the pointers, latest.json last'
const HELPERS = 'the R2 helpers, sourced by the steps that hold the key'

describe('the four workflows', () => {
  test('exactly build.yaml, test.yaml, tag.yaml and release.yaml', () => {
    expect(readdirSync(join(GITHUB, 'workflows')).sort()).toEqual(['build.yaml', 'release.yaml', 'tag.yaml', 'test.yaml'])
  })

  test('build.yaml: every push to main, by hand with test (default on), called with test and giving version', () => {
    expect(Object.keys(build.on)).toEqual(['push', 'workflow_dispatch', 'workflow_call'])
    expect(build.on['push']).toEqual({ branches: ['main'] })
    const dispatch = build.on['workflow_dispatch']!.inputs!
    expect(Object.keys(dispatch)).toEqual(['test', 'version', 'skip_targets'])
    expect(dispatch['test']).toEqual({ description: expect.any(String), required: false, default: true, type: 'boolean' })
    for (const name of ['version', 'skip_targets']) {
      expect(dispatch[name]).toEqual({ description: expect.any(String), required: false, default: '', type: 'string' })
    }
    const call = build.on['workflow_call']!
    expect(Object.keys(call.inputs!)).toEqual(['test', 'version'])
    expect(call.inputs!['test']).toMatchObject({ default: true, type: 'boolean' })
    expect(call.outputs!['version']!.value).toBe('${{ jobs.plan.outputs.version }}')
  })

  test('build.yaml ends with test.yaml on this run: always after a push, by hand unless unticked, when the caller asks', () => {
    const job = build.jobs['test']!
    expect(Object.keys(build.jobs)).toEqual(['plan', 'build', 'guest', 'pkgs', 'test'])
    expect(needs(build, 'test')).toEqual(['pkgs'])
    expect(job.uses).toBe('./.github/workflows/test.yaml')
    expect(job.with).toEqual({ run: '${{ github.run_number }}' })
    expect(job.secrets).toBe('inherit')
    expect(job.if).toBe("github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && github.event.inputs.test != 'false') || (github.event_name == 'workflow_call' && inputs.test)")
  })

  test('test.yaml: by hand with run (empty: the newest) and the WPT mode, or called with run', () => {
    expect(Object.keys(tests.on)).toEqual(['workflow_dispatch', 'workflow_call'])
    const dispatch = tests.on['workflow_dispatch']!.inputs!
    expect(Object.keys(dispatch)).toEqual(['run', 'wpt', 'workers'])
    expect(dispatch['run']).toEqual({ description: expect.any(String), required: false, default: '', type: 'string' })
    expect(dispatch['wpt']!.options).toEqual(['gate', 'full', 'baseline'])
    expect(tests.on['workflow_call']!.inputs).toEqual({ run: { description: expect.any(String), required: true, type: 'string' } })
  })

  test('tag.yaml: by hand only; build (with its test), then the tag, then release.yaml on this run; npm last', () => {
    expect(Object.keys(tag.on)).toEqual(['workflow_dispatch'])
    expect(Object.keys(tag.on['workflow_dispatch']!.inputs!)).toEqual(['version'])
    expect(Object.keys(tag.jobs)).toEqual(['build', 'tag', 'release', 'npm'])
    expect(tag.jobs['build']).toEqual({
      uses: './.github/workflows/build.yaml', with: { test: true, version: '${{ github.event.inputs.version }}' }, secrets: 'inherit',
    } as unknown as Job)
    expect(needs(tag, 'tag')).toEqual(['build'])
    expect(tag.jobs['tag']!.env).toEqual({ TAG: 'v${{ needs.build.outputs.version }}', SHA: '${{ github.sha }}' })
    expect(needs(tag, 'release')).toEqual(['build', 'tag'])
    expect(tag.jobs['release']).toMatchObject({
      uses: './.github/workflows/release.yaml', secrets: 'inherit',
      with: { run: '${{ github.run_number }}', version: '${{ needs.build.outputs.version }}', tag: 'v${{ needs.build.outputs.version }}' },
    })
    expect(needs(tag, 'npm')).toEqual(['build', 'release'])
  })

  test('release.yaml: called only (never dispatched), with run required, version and tag', () => {
    expect(Object.keys(release.on)).toEqual(['workflow_call'])
    const inputs = release.on['workflow_call']!.inputs!
    expect(Object.keys(inputs)).toEqual(['run', 'version', 'tag'])
    expect(inputs['run']).toMatchObject({ required: true, type: 'string' })
    expect(Object.keys(release.jobs)).toEqual(['r2', 'pacman'])
    expect(needs(release, 'pacman')).toEqual(['r2'])
  })

  test('release.yaml only uploads to R2: no tag, no npm, no other host written', () => {
    expect(RELEASE).not.toMatch(/git (tag|push)|npm (publish|view)|NPM_TOKEN|rsync|ARTIFACTS_UPLOAD_KEY|contents: write/)
    expect(RELEASE).not.toContain('GITHUB_RUN_NUMBER')
    expect(runs(release, 'r2')).toContain("printf 'acdev/%s/acdev-release\\n' \"$RUN\" | nc $PULL | tar -x")
  })

  test('read-only by default; only tag.yaml\'s tag job writes, and only contents', () => {
    for (const wf of [build, tests, tag, release]) expect(wf.permissions).toEqual({ contents: 'read' })
    const writers = [build, tests, tag, release].flatMap((wf) => Object.entries(wf.jobs).filter(([, job]) => job.permissions))
    expect(writers.map(([id, job]) => [id, job.permissions])).toEqual([['tag', { contents: 'write' }]])
  })

  test('no workflow has a concurrency group: runs never wait for one another', () => {
    expect(tag.concurrency).toBeUndefined()
    expect(build.concurrency).toBeUndefined()
    expect(tests.concurrency).toBeUndefined()
    expect(release.concurrency).toBeUndefined()
  })

  test('dispatch inputs are read from github.event.inputs; inputs.* only where a caller gives them', () => {
    for (const text of [BUILD, TEST]) {
      for (const match of text.matchAll(/\binputs\.(\w+)/g)) {
        const before = text.slice(Math.max(0, match.index! - 13), match.index)
        if (before.endsWith('event.')) continue
        expect(['inputs.version', 'inputs.test', 'inputs.run']).toContain(match[0])
      }
    }
    expect(TAG).not.toMatch(/(?<!event\.)\binputs\./)
    expect(step(build, 'plan', 'release or preview, the version, libacde\'s main and the targets')!.env).toMatchObject({
      EVENT: '${{ github.event_name }}', CALL_VERSION: '${{ inputs.version }}', DISPATCH_VERSION: '${{ github.event.inputs.version }}',
    })
  })
})

describe('build.yaml', () => {
  const jobs = build.jobs

  test('the jobs and their needs; pkgs goes on unless a build failed; a skipped target skips its build leg', () => {
    expect(needs(build, 'plan')).toEqual([])
    expect(needs(build, 'build')).toEqual(['plan'])
    expect(needs(build, 'guest')).toEqual(['plan'])
    expect(needs(build, 'pkgs')).toEqual(['plan', 'build', 'guest'])
    expect(jobs['build']!.if).toBe("contains(format(',{0},', needs.plan.outputs.targets), format(',{0},', matrix.triple))")
    expect(jobs['pkgs']!.if).toContain("needs.build.result != 'failure'")
    expect(jobs['pkgs']!.if).toContain("needs.guest.result == 'success'")
  })

  test('a called build is a release, anything else a preview; a release comes from main only', () => {
    const plan = runs(build, 'plan')
    expect(plan).toContain('if [ "$EVENT" = workflow_call ]; then')
    expect(plan).toContain('RELEASE=true VERSION_INPUT=${CALL_VERSION:-} SKIP=')
    expect(plan).toContain('RELEASE=false VERSION_INPUT=${DISPATCH_VERSION:-} SKIP=${DISPATCH_SKIP:-}')
    expect(plan).toContain('[ "$GITHUB_REF" = refs/heads/main ] || { echo "::error::a release is made from main only')
    expect(plan).toContain('git merge-base --is-ancestor "$sha" origin/main')
    expect(plan).toContain('sha=$GITHUB_SHA')
    const outputs = ['release', 'sha', 'libacde', 'version', 'targets']
    expect(jobs['plan']!.outputs).toEqual(Object.fromEntries(outputs.map((name) => [name, `\${{ steps.version.outputs.${name} }}`])))
  })

  test('the version: the input, else a v* tag on the commit (a rerun), else one patch past the highest released', () => {
    const plan = runs(build, 'plan')
    const input = indexIn(plan, 'v=${VERSION_INPUT#v}')
    const tagged = indexIn(plan, 'v=$tagged_as')
    expect(input).toBeLessThan(tagged)
    expect(tagged).toBeLessThan(indexIn(plan, '$3 + 1'))
    expect(plan).toContain("git tag --points-at \"$sha\" --list 'v*'")
    expect(plan).toContain("git tag --list 'v*'")
    expect(plan).toContain('already exists and points at $tagged, not at $sha: bump the version')
  })

  test('build, guest and pkgs reuse what an earlier run built for the same inputs (built/ on .127), skipping steps, not the job', () => {
    for (const job of ['build', 'guest', 'pkgs']) {
      const all = steps(build, job)
      const reuse = all.findIndex((item) => item.id === 'reuse')
      expect(reuse, job).toBe(all.findIndex((item) => item.name === 'the upload key for the artifacts host') + 1)
      expect(jobs[job]!.env?.['SOURCES'], job).toContain('${{ needs.plan.outputs.sha }}')
      for (const item of all.slice(reuse + 1)) {
        if (/(^|\/)checkout@/.test(item.uses ?? '') || /cargo|bun |record this run/.test(item.run ?? '')) expect(item.if, `${job}: ${item.name}`).toBe("steps.reuse.outputs.build == 'true'")
      }
    }
    expect(runs(build, 'build')).toContain('"$r/$D/" "$TO:$GITHUB_RUN_NUMBER/$D/"')
    expect(runs(build, 'plan')).toContain('acdev/built/libacde-%s-%s')
  })

  test('a preview says so after the guard; run.json names the commit, libacde and whether it is a release', () => {
    const pkgs = runs(build, 'pkgs')
    expect(indexIn(pkgs, 'release-guard.ts')).toBeLessThan(indexIn(pkgs, 'preview only'))
    expect(pkgs).toContain('{"version":"%s","commit":"%s","libacde":"%s","release":"%s","run":%s}')
  })

  test('the plan checkout fetches history; every later checkout is the resolved commit, keeping no token', () => {
    expect(checkoutOf(build, 'plan')?.with?.['fetch-depth']).toBe(0)
    for (const job of ['build', 'guest', 'pkgs']) expect(checkoutOf(build, job)?.with?.['ref']).toBe('${{ needs.plan.outputs.sha }}')
    for (const job of Object.keys(jobs).filter((id) => !jobs[id]!.uses)) {
      for (const item of steps(build, job)) if (/(^|\/)checkout@/.test(item.uses ?? '')) expect(item.with?.['persist-credentials']).toBe(false)
    }
  })

  test('one version: set into Cargo.toml, npm/package.json and the SDK before building and packing', () => {
    expect(indexIn(runs(build, 'build'), 'sh scripts/set-version.sh "$V" .')).toBeLessThan(indexIn(runs(build, 'build'), '--profile dist'))
    expect(jobs['build']!.env?.['V']).toBe('${{ needs.plan.outputs.version }}')
    const pkgs = runs(build, 'pkgs')
    expect(indexIn(pkgs, 'set-version.sh "$V" ..')).toBeLessThan(indexIn(pkgs, 'bun scripts/dist.ts'))
    expect(pkgs).toContain('--api "$w/libacde/acde-api" --sdk "$V"')
  })

  test('each target builds acdev and acdevtool and packs acdevrt-<triple> and acdevtools-<triple>; the guest job acdevd', () => {
    expect(jobs['build']!.strategy!.matrix.include.map((leg) => [leg['triple'], leg['cargo'], leg['runner']])).toEqual([
      ['aarch64-apple-darwin', 'zigbuild', 'aarch64-debian'], ['x86_64-apple-darwin', 'zigbuild', 'x86_64-debian'],
      ['x86_64-unknown-linux-gnu', 'build', 'x86_64-debian'], ['x86_64-pc-windows-msvc', 'xwin build', 'x86_64-debian'],
    ])
    const text = runs(build, 'build')
    expect(text).toContain('cargo ${{ matrix.cargo }} --locked --profile dist -p acdev --target $T')
    expect(text).toContain('(cd crates/tool && cargo ${{ matrix.cargo }} --locked --release --target $T)')
    expect(text).toContain('pack acdevrt "acdev/target/$T/dist/acdev$x" "acdev$x"')
    expect(text).toContain('pack acdevtools "acdev/crates/tool/target/$T/release/acdevtool$x" "acdevtool$x"')
    expect(text).toContain('SDKROOT=/opt/cross/MacOSX15.5.sdk')
    expect(text).toContain('XWIN_CACHE_DIR=$HOME/.cache/cargo-xwin-atl')
    expect(indexIn(text, 'bun install --frozen-lockfile --cwd ../libacde/js')).toBeLessThan(indexIn(text, '--profile dist'))
    for (const job of ['build', 'pkgs']) expect(steps(build, job).some((item) => item.name?.startsWith('libacde beside acdev')), job).toBe(true)
    const guest = runs(build, 'guest')
    expect(guest).toContain('cargo build --locked --release --target $a-unknown-linux-musl')
    expect(guest).toContain('acdev-guest-${{ needs.plan.outputs.version }}.tar.gz')
    expect(runs(build, 'pkgs')).toContain('cp "$w"/in/*/*.tar.* "$w/shipped/"')
    expect(runs(build, 'pkgs')).toContain('--runtime "$w/shipped"')
  })

  test('the guard checks the exact allow-list before .127\'s latest moves', () => {
    const pkgs = runs(build, 'pkgs')
    expect(pkgs).toContain('bun ../scripts/release-guard.ts --dir "$GITHUB_WORKSPACE/out" --version "$V" --targets "$TARGETS"')
    expect(indexIn(pkgs, 'release-guard.ts')).toBeLessThan(indexIn(pkgs, 'run/latest "$TO:"'))
  })

  test('nothing leaves for R2, npm or a tag', () => {
    expect(BUILD).not.toMatch(/R2_|r2\.cloudflarestorage|npm publish|NPM_TOKEN|git push|tag -a|contents: write/)
  })
})

describe('test.yaml', () => {
  const jobs = tests.jobs

  test('pick resolves the run once (the input, else acdev/latest) and reads its run.json; every job needs it', () => {
    const pick = runs(tests, 'pick')
    expect(pick).toContain('if [ "$EVENT" = workflow_call ]; then run=${CALL_RUN:-}; else run=${DISPATCH_RUN:-}; fi')
    expect(pick).toContain("printf 'acdev/latest\\n' | nc $PULL | tar -xO")
    expect(pick).toContain("printf 'acdev/%s/run.json\\n' \"$run\" | nc $PULL | tar -xO")
    for (const name of ['commit', 'libacde']) expect(pick).toContain(`.${name} // empty`)
    for (const job of ['gate', 'wpt', 'demo']) expect(needs(tests, job), job).toEqual(['pick'])
    expect(needs(tests, 'expectations')).toEqual(['pick', 'wpt'])
  })

  test('never builds: the runtime is the run\'s acdevrt from .127; acdev and libacde at the commits it packed', () => {
    expect(TEST).not.toMatch(/\bcargo\b|rustup|RUSTUP_HOME|set-version/)
    const runtime = steps(tests, 'gate').find((item) => item.name?.startsWith('the run\'s Linux runtime'))!.run!
    expect(runtime).toContain("printf 'acdev/%s/%s\\n' \"$RUN\" \"$d\" | nc $PULL | tar -x")
    expect(runtime).toContain('acdevrt-x86_64-unknown-linux-gnu.tar.zst')
    expect(tests.env['ACDEV_RUNTIME']).toBe('${{ github.workspace }}/runtime/acdev')
    for (const job of ['gate', 'wpt', 'expectations', 'demo']) {
      expect(checkoutOf(tests, job)?.with?.['ref'], job).toBe('${{ needs.pick.outputs.commit }}')
      expect(checkoutOf(tests, job)?.with?.['persist-credentials'], job).toBe(false)
      expect(steps(tests, job).find((item) => item.name?.startsWith('libacde beside acdev'))!.env!['REF'], job).toBe('${{ needs.pick.outputs.libacde }}')
      expect(jobs[job]!.env?.['RUN'], job).toBe('${{ needs.pick.outputs.run }}')
    }
  })

  test('the gate after a build; full and baseline only by hand', () => {
    expect(jobs['gate']!.if).toBe("github.event_name != 'workflow_dispatch' || github.event.inputs.wpt == 'gate'")
    for (const job of ['wpt', 'demo']) expect(jobs[job]!.if).toBe("github.event_name == 'workflow_dispatch' && github.event.inputs.wpt != 'gate'")
    expect(jobs['expectations']!.if).toContain("github.event_name == 'workflow_dispatch' && github.event.inputs.wpt == 'baseline'")
    expect(tests.env['WORKERS']).toBe("${{ github.event_name == 'workflow_dispatch' && github.event.inputs.workers || '20' }}")
  })

  test('the shared steps are anchored once', () => {
    for (const anchor of ['&checkout', '&cleanup', '&libacde', '&runtime', '&ssh', '&wpt']) expect(TEST.split(anchor).length - 1, anchor).toBe(1)
    expect(TEST).toContain('[ ! -d "${p%%/hostexecutor/*}" ]')
  })
})

describe('tag.yaml', () => {
  test('the tag is annotated, on this commit, never moved or forced; a rerun on the same commit continues', () => {
    const run = runs(tag, 'tag')
    expect(checkoutOf(tag, 'tag')?.with).toMatchObject({ ref: '${{ github.sha }}', 'persist-credentials': true })
    expect(run).toContain('test "$(git rev-parse HEAD)" = "$SHA"')
    expect(run).toContain('tag -a "$TAG" -m "acdev $TAG" "$SHA"')
    expect(run).toContain('a rerun continues')
    expect(run).toContain('bump the version')
    expect(run).not.toMatch(/git tag (?!-a)/)
    expect(run).not.toMatch(/git push[^\n]*(--force|\s-f\b|\+refs)/)
  })

  test('npm publishes the platform packages and @dopame/acdev from this run\'s checked release, not the private SDK', () => {
    const npm = step(tag, 'npm', 'npm (platforms, then @dopame/acdev)')!.run!
    expect(npm).toContain('for dir in npm/acdev-*-* npm/acdev; do')
    expect(npm).toContain('"$rel/acdevrt-$t".tar.* "$rel/acdevtools-$t".tar.*')
    expect(npm).not.toMatch(/acdev-api|acde-api-\*/)
    expect(npm).toContain('no NPM_TOKEN secret: nothing published to npm')
    const pull = runs(tag, 'npm')
    expect(indexIn(pull, 'sha256sum -c SHA256SUMS')).toBeLessThan(indexIn(pull, 'npm publish'))
  })
})

describe('release.yaml', () => {
  test('R2 gets the versioned files, then the pointers, latest.json last; no CDN to invalidate', () => {
    const run = runs(release, 'r2')
    const order = ['sha256sum -c SHA256SUMS', 'publish_once "$f"', 'publish_once SHA256SUMS', 'pointer install.sh', 'pointer install.ps1',
      'pointer install.md', 'pointer latest ', 'pointer latest.json']
    const at = order.map((needle) => indexIn(run, needle))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(run).toContain('does not read back as uploaded')
    expect(run).toContain('[ "$(cat out/latest)" = "$V" ]')
    expect(run).toContain('[ "$(jq -r .tag out/latest.json)" = "$TAG" ]')
    expect(ALL).not.toMatch(/cloudfront|invalidation|\baws (s3|s3api|sts)\b|AWS_|dopame-pkgs|myqcloud|amazonaws/i)
    const keyed = steps(release, 'r2').filter((item) => item.env?.['R2_SECRET_ACCESS_KEY']).map((item) => item.name)
    expect(keyed).toEqual([UPLOAD, POINTERS])
  })

  test('R2 through its S3 API: curl --aws-sigv4, the key on stdin, the bucket and endpoint stated once', () => {
    const helpers = step(release, 'r2', HELPERS)!
    expect(helpers.run).toContain("| curl -K - --aws-sigv4 'aws:amz:auto:s3'")
    expect(helpers.run).toContain('endpoint=https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com/$R2_BUCKET')
    expect(helpers.run).not.toMatch(/curl[^\n]*\$R2_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)/)
    expect(helpers.env).toBeUndefined()
    for (const name of [UPLOAD, POINTERS]) expect(step(release, 'r2', name)!.run).toStartWith('. "$RUNNER_TEMP/r2.sh"\n')
    const run = runs(release, 'r2')
    expect(run).toContain("pointer() { put \"$PREFIX/$1\" \"$1\" \"$2\" 'public, max-age=0, must-revalidate'; }")
    expect(run).toContain("put \"$key\" \"$1\" \"$type\" 'public, max-age=31536000, immutable'")
    expect(run).toContain('*.tar.zst) type=application/zstd ;;')
  })

  test('R2 is written file by file, with no sync, recursion or globs; names are checked', () => {
    const run = runs(release, 'r2')
    expect(run).not.toMatch(/\bsync\b|--recursive|\bcp -r\b/)
    expect(run).not.toMatch(/(put|pointer|publish_once) [^\n]*\*/)
    expect(run).toContain('*[!A-Za-z0-9._-]*) echo "::error::bad file name $f"')
  })

  test('a published version is identical or refused, never overwritten, and a rerun can continue', () => {
    const run = runs(release, 'r2')
    expect(run).toContain('if get "$key" "$RUNNER_TEMP/published"; then')
    expect(run).toContain('cmp -s "$RUNNER_TEMP/published" "$1"')
    expect(run).toContain('already published, identical')
    expect(run).toContain('a version is never overwritten')
  })

  test('pacman: os\'s acdev-package.sh makes the package of run `run` with zstd -3, os\'s publish.sh adds it to agentcomputer, once per version', () => {
    const run = runs(release, 'pacman')
    expect(run).toContain('clone --depth 1 "${GITHUB_SERVER_URL}/AC/os.git" "$RUNNER_TEMP/os"')
    expect(step(release, 'pacman', 'os\'s packaging and publish scripts')!.env).toEqual({ TOKEN: '${{ secrets.ACKERNEL_TOKEN || github.token }}' })
    expect(run).toContain("'COMPRESSZST=(zstd -c -T0 -3 -)' > \"$conf/pacman/makepkg.conf\"")
    expect(run).toContain('XDG_CONFIG_HOME=$conf "$RUNNER_TEMP/os/scripts/ci/acdev-package.sh" "$RUNNER_TEMP/package" "$RUN"')
    expect(release.jobs['pacman']!.env!['REPO']).toBe('agentcomputer')
    expect(run).toContain('"$RUNNER_TEMP/os/scripts/publish.sh" "$REPO" "$RUNNER_TEMP"/package/acdev-"$V"-*-x86_64.pkg.tar.zst')
    expect(indexIn(run, '"$PKGS/$REPO/$REPO.db"')).toBeLessThan(indexIn(run, 'acdev-package.sh'))
    for (const item of steps(release, 'pacman').filter((item) => item.name !== 'tools' && item.name !== 'clean up' && !item.id)) {
      expect(item.if, item.name).toBe("steps.db.outputs.have != 'true'")
    }
    expect(step(release, 'pacman', 'publish')!.env).toEqual(KEYS)
  })

  test('the bucket, prefix and PKGS are each stated once', () => {
    expect(release.env).toEqual({ PKGS: 'https://pkgs.dopame.ai', R2_BUCKET: 'pkgs', PREFIX: 'acdev', PULL: '192.168.10.127 9127' })
    expect(Pkgs.BASE).toBe(release.env['PKGS']!)
    expect(Pkgs.ACDEV).toBe(`${release.env['PKGS']}/${release.env['PREFIX']}`)
    expect(build.env['PKGS']).toBe(Pkgs.BASE)
    expect(build.env['PREFIX']).toBe('acdev')
  })
})

describe('all four', () => {
  const each = [build, tests, tag, release] as const

  test('the toolchains are the runner\'s (scripts/runner-setup.sh): no job installs or sets up anything', () => {
    expect(existsSync(join(GITHUB, '..', 'scripts', 'runner-setup.sh'))).toBe(true)
    expect(ALL).not.toMatch(/apt-get|setup-bun|rust-toolchain@|rust-cache@|rustup |curl [^\n]*(zig|xwin|zigbuild|sdk)/i)
    expect(build.env['RUSTUP_HOME']).toBe('/opt/rust/rustup')
    expect(ALL).not.toContain('RUNNER_TEMP/home')
    for (const wf of each) {
      for (const id of Object.keys(wf.jobs).filter((id) => !(wf === release && id === 'pacman') && !wf.jobs[id]!.uses)) {
        expect(runs(wf, id), id).not.toContain('pacman -S')
      }
    }
  })

  test('every job runs on the runners themselves, in no container: x86_64-debian, Apple silicon on aarch64-debian, pacman on x86_64-arch', () => {
    for (const wf of each) {
      for (const [id, job] of Object.entries(wf.jobs)) {
        if (job.uses) continue
        const want = wf === build && id === 'build' ? '${{ matrix.runner }}' : wf === release && id === 'pacman' ? 'x86_64-arch' : 'x86_64-debian'
        expect(job['runs-on'], id).toBe(want)
        expect(job.container, id).toBeUndefined()
      }
    }
  })

  test('credentials are only where used, never echoed, and set -x is never used', () => {
    const secrets = (text: string) => [...new Set([...text.matchAll(/\bsecrets\.(\w+)/g)].map((match) => match[1]))].sort()
    expect(secrets(BUILD)).toEqual(['ACKERNEL_TOKEN', 'ARTIFACTS_UPLOAD_KEY'])
    expect(secrets(TEST)).toEqual(['ACKERNEL_TOKEN', 'ARTIFACTS_UPLOAD_KEY'])
    expect(secrets(TAG)).toEqual(['NPM_TOKEN'])
    expect(secrets(RELEASE)).toEqual(['ACKERNEL_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_ACCOUNT_ID', 'R2_SECRET_ACCESS_KEY'])
    expect(ALL.match(/secrets\.R2_SECRET_ACCESS_KEY/g)).toHaveLength(1)
    expect(ALL).not.toMatch(/set -x|bash -x|sh -x|aws-actions\//)
    const printed = ALL.split('\n').filter((line) => /echo|printf/.test(line) && !/> "\$k\/key"|\| curl -K - /.test(line))
    expect(printed.filter((line) => /\$(token|secret|session|creds|KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY)\b/.test(line))).toEqual([])
  })

  test('no .github/actions: the workflows say every step, the shared ones anchored once per file', () => {
    expect(existsSync(join(GITHUB, 'actions'))).toBe(false)
    expect(ALL).not.toContain('.github/actions')
    for (const anchor of ['&checkout', '&libacde', '&ssh', '&reuse', '&record']) expect(BUILD.split(anchor).length - 1, anchor).toBe(1)
    expect(RELEASE.split('&keys').length - 1).toBe(1)
  })

  test('every job\'s output goes to the artifacts host: rsync over ssh with a write-only key, read back with nc + tar', () => {
    for (const wf of [build, tests]) expect(wf.env['TO']).toBe('artifacts@192.168.10.127')
    for (const wf of each) expect(wf.env['PULL']).toBe('192.168.10.127 9127')
    expect(ALL).not.toMatch(/gitea-(upload|download)-artifact/)
    for (const text of [BUILD, TEST]) {
      expect(text).toContain('KEY: ${{ secrets.ARTIFACTS_UPLOAD_KEY }}')
      expect(text).toContain('192.168.10.127 ssh-ed25519 ')
    }
    expect(runs(build, 'build')).toContain('out/ "$TO:$GITHUB_RUN_NUMBER/build-$T/"')
    expect(runs(build, 'guest')).toContain('"$o/" "$TO:$GITHUB_RUN_NUMBER/guest/"')
    expect(runs(build, 'pkgs')).toContain('out/ "$TO:$GITHUB_RUN_NUMBER/acdev-release/"')
    expect(runs(build, 'pkgs')).toContain('nc $PULL | tar -x')
    expect(runs(tag, 'npm')).toContain("printf 'acdev/%s/acdev-release\\n' \"$GITHUB_RUN_NUMBER\" | nc $PULL | tar -x")
    for (const line of ALL.split('\n').filter((line) => /^\s*(\[[^\n]*\|\| )?rsync /.test(line) && line.includes('$TO:') && !line.includes('"$TO:"'))) {
      expect(line).toContain('--mkpath')
    }
    expect(ALL).not.toMatch(/rsync[^\n]*--delete|\$TO:[^\n"]*\/[A-Za-z.]+"$/m)
  })

  test('every remote action is pinned to a full commit SHA with its version noted', () => {
    const all = each.flatMap((wf) => Object.keys(wf.jobs).filter((id) => !wf.jobs[id]!.uses).flatMap((id) => steps(wf, id).map((item) => item.uses)))
      .filter((action): action is string => !!action)
    expect(all.length).toBeGreaterThan(0)
    for (const action of all) expect(action).toMatch(/^http:\/\/gitea\.dopamine\/mirror\/[\w.-]+@[0-9a-f]{40}$/)
    expect(ALL.match(/@[0-9a-f]{40}(?! # v\d+)/g)).toBeNull()
  })

  test('the lockfile fetches every package from the default registry, not a mirror', () => {
    expect(LOCK).not.toContain('mirrors.cloud.tencent.com')
  })
})
