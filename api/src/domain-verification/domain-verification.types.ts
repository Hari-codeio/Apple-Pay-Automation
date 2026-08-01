/**
 * Row shape of `phoenix_release.apple_pay_domain_verifications`.
 *
 * Mirrors the live table, which this service does NOT own. Timestamps are
 * strings, not Dates: the driver runs with `dateStrings: true` because
 * converting a timezone-less DATETIME using the process timezone silently
 * shifts every value.
 */

/**
 * `status` enum, verbatim from the column definition.
 *  - pending:    registered with Apple, not yet confirmed verified
 *  - active:     verified and serving
 *  - superseded: replaced by a newer association file
 *  - failed:     registration or verification did not complete
 */
export type VerificationStatus = 'pending' | 'active' | 'superseded' | 'failed';

export interface DomainVerificationRecord {
  id: string;
  domain: string;
  storeCode: number | null;
  merchantId: string | null;
  verificationFile: string;
  createdAt: string | null;
  updatedAt: string | null;
  appleTeamId: string | null;
  appleDateCreated: string | null;
  verificationExpiresAt: string | null;
  status: VerificationStatus;
  contentSha256: string | null;
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastVerifiedAt: string | null;
  isDeleted: boolean;
}

export interface UpsertVerificationInput {
  domain: string;
  storeCode: number | null;
  merchantId: string;
  appleTeamId: string;
  verificationFile: string;
  contentSha256: string;
  status: VerificationStatus;
  /**
   * Null at registration time. Apple only publishes an expiry once it has
   * verified the domain, so the real value arrives later via
   * `markActive` — see domain-verification.service.ts.
   */
  verificationExpiresAt: Date | null;
}

export type ProbeFailureReason =
  'unreachable' | 'http-error' | 'redirect' | 'content-mismatch';

export interface ProbeOutcome {
  ok: boolean;
  attempts: number;
  url: string;
  httpStatus?: number;
  reason?: ProbeFailureReason;
  detail?: string;
}

export interface RegistrationResult {
  domain: string;
  status: VerificationStatus;
  contentSha256: string;
  /** Where the downloaded file was kept, for post-mortem inspection. */
  savedTo: string;
  probe?: ProbeOutcome;
  /**
   * 'skipped' when the caller asked not to trigger Apple's check. 'failed' means
   * Apple explicitly rejected it and said why; 'unknown' means it gave no verdict.
   */
  verification: 'verified' | 'failed' | 'unknown' | 'skipped' | 'not-attempted';
  /**
   * Apple's published expiry, ISO-8601, or null when Apple has not verified the
   * domain yet or published no readable date. Never a locally computed guess.
   */
  verificationExpiresAt: string | null;
}
