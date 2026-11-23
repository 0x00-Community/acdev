export const TOKEN_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, 'GitHub token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/aws_secret_access_[k]ey/i, 'AWS secret key name'],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?(-----END (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----|$)/, 'private key'],
]

export const SECRET_REFERENCE: readonly [RegExp, string] = [/secret:\/\/[^\s"'`<>)\]}]+/, 'secret reference']

export const USER_ONLY_SELECTOR = '[data-user-only]'

export const SYSTEM_WINDOW_MODES = ['lock', 'confirm'] as const

export const PLACEHOLDER = '[redacted]'

export const BLOCK_RGBA: readonly [number, number, number, number] = [40, 40, 40, 255]
