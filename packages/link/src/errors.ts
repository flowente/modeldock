export type LinkErrorCode =
  | "invite_invalid"
  | "invite_expired"
  | "invite_used"
  | "invite_locked"
  | "pin_required"
  | "pin_invalid"
  | "device_not_found"
  | "fingerprint_mismatch"
  | "unreachable"
  | "bad_request"
  | "rate_limited";

const HTTP_STATUS: Record<LinkErrorCode, number> = {
  invite_invalid: 404,
  invite_expired: 410,
  invite_used: 410,
  invite_locked: 423,
  pin_required: 401,
  pin_invalid: 401,
  device_not_found: 404,
  fingerprint_mismatch: 495,
  unreachable: 502,
  bad_request: 400,
  rate_limited: 429
};

export class LinkError extends Error {
  public readonly code: LinkErrorCode;
  public readonly httpStatus: number;

  public constructor(code: LinkErrorCode, message: string) {
    super(message);
    this.name = "LinkError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}
