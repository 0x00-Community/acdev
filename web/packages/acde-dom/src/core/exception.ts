const CODES: Record<string, number> = {
  IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5, NoModificationAllowedError: 7,
  NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10, InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13,
  NamespaceError: 14, InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20,
  URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25,
}

export class DOMException extends Error {
  static readonly INDEX_SIZE_ERR = 1
  static readonly DOMSTRING_SIZE_ERR = 2
  static readonly HIERARCHY_REQUEST_ERR = 3
  static readonly WRONG_DOCUMENT_ERR = 4
  static readonly INVALID_CHARACTER_ERR = 5
  static readonly NO_DATA_ALLOWED_ERR = 6
  static readonly NO_MODIFICATION_ALLOWED_ERR = 7
  static readonly NOT_FOUND_ERR = 8
  static readonly NOT_SUPPORTED_ERR = 9
  static readonly INUSE_ATTRIBUTE_ERR = 10
  static readonly INVALID_STATE_ERR = 11
  static readonly SYNTAX_ERR = 12
  static readonly INVALID_MODIFICATION_ERR = 13
  static readonly NAMESPACE_ERR = 14
  static readonly INVALID_ACCESS_ERR = 15
  static readonly VALIDATION_ERR = 16
  static readonly TYPE_MISMATCH_ERR = 17
  static readonly SECURITY_ERR = 18
  static readonly NETWORK_ERR = 19
  static readonly ABORT_ERR = 20
  static readonly URL_MISMATCH_ERR = 21
  static readonly QUOTA_EXCEEDED_ERR = 22
  static readonly TIMEOUT_ERR = 23
  static readonly INVALID_NODE_TYPE_ERR = 24
  static readonly DATA_CLONE_ERR = 25

  readonly #name: string

  constructor(message = '', name = 'Error') {
    super(String(message))
    this.#name = String(name)
  }

  override get name(): string {
    return this.#name
  }

  get code(): number {
    return CODES[this.#name] ?? 0
  }
}
Object.defineProperty(DOMException.prototype, Symbol.toStringTag, { value: 'DOMException', configurable: true })

const NATIVE = /^([A-Z][A-Za-z]*Error): ([\s\S]*)$/

function domError(error: unknown): unknown {
  if (error !== null && typeof error === 'object' && !(error instanceof DOMException) && typeof (error as Error).message === 'string') {
    const m = NATIVE.exec((error as Error).message)
    if (m && m[1]! in CODES) return new DOMException(m[2], m[1])
  }
  return error
}

export function guard<T>(call: () => T): T {
  try {
    return call()
  } catch (error) {
    throw domError(error)
  }
}
