/**
 * Every selector for developer.apple.com in one file.
 *
 * This DOM belongs to Apple and changes without notice or versioning. When a run
 * fails with a selector timeout, this is the only file that needs editing — and
 * the Playwright trace (PLAYWRIGHT_TRACE_ON_FAILURE) shows the DOM as it was at
 * the moment of failure so the replacement can be written from evidence.
 *
 * The merchant-page selectors are the ones observed on the portal and recorded
 * in the project brief. They are long and structural, which is exactly why each
 * one below is paired with a semantic fallback in `apple-portal.client.ts`:
 * `div:nth-child(3)` breaks the first time Apple inserts a banner.
 */

/**
 * Selectors verified against the live portal (2026-08-01).
 *
 * Preferred over the brief's structural paths because they are anchored on
 * Apple's own semantic classes and attributes. The structural equivalents are
 * kept in MERCHANT_STRUCTURAL_SELECTORS as a second opinion.
 *
 * WHERE THE DOWNLOAD LIVES — the thing that cost the most to establish. The
 * association-file Download exists ONLY on the confirmation screen rendered
 * after Save, never on the domain list. Confirmed exhaustively: of the 50
 * `.actions-container` elements on a merchant page with 47 domains, every domain
 * row holds exactly `Remove` + `Verify`, and the only two download anchors on the
 * page are certificate downloads (`downloadCertificateContent.action`). So the
 * file is obtainable at registration time and at no other point.
 */
export const MERCHANT_SELECTORS = {
  /** Opens the "Add Domain" form on the merchant identifier edit page. */
  addDomain: '#form-merchantId button.action-add',
  /** Text input for the domain being registered. */
  domainInput: '#domainName',
  /** Commits the domain. */
  save: '#action-save',
  /**
   * Downloads apple-developer-merchantid-domain-association, on the post-Save
   * confirmation screen.
   *
   * Keyed on the `download` ATTRIBUTE, which is what makes this safe: Apple's
   * global navigation contains a hidden `<a>Downloads</a>` pointing at
   * developer.apple.com/download/, and a text match on "Download" selects it
   * (`has-text` is a substring match, so "Downloads" matches too). That link has
   * no `download` attribute and is outside `#form-merchantId`; this selector
   * excludes it on both counts.
   */
  download: '#form-merchantId .actions-container a[download]',
  /** Tells Apple to fetch the association file from the domain and verify it. */
  verify: '#form-merchantId .actions-container button.action-verify',
} as const;

/**
 * The structural paths recorded in the project brief. Kept as a fallback: they
 * are precise about position (`span:nth-child(1)`, matching the two spans the
 * confirmation screen really does render) but break the moment Apple inserts a
 * wrapper.
 */
export const MERCHANT_STRUCTURAL_SELECTORS = {
  addDomain:
    '#form-merchantId > div > div:nth-child(3) > div.apple-pay-on-the-web > div.cert-block-container > div:nth-child(3) > button',
  download:
    '#form-merchantId > div > div > div > section > div.actions-container > span:nth-child(1) > a',
  verify:
    '#form-merchantId > div > div > div > section > div.actions-container > span:nth-child(2) > button',
} as const;

/**
 * Semantic fallbacks, tried when the structural selector above matches nothing.
 * Accessible-name matching survives layout changes that positional selectors do
 * not, but is sensitive to Apple's own copy changes — hence both, not either.
 */
export const MERCHANT_FALLBACK_SELECTORS = {
  addDomain: '#form-merchantId button:has-text("Add Domain")',
  domainInput: 'input[name="domainName"]',
  save: '#form-merchantId button:has-text("Save")',
  // Every fallback is scoped to #form-merchantId. An unscoped
  // `a:has-text("Download")` matched Apple's hidden global-nav "Downloads" link
  // and burned a 20s click timeout on an invisible element.
  download: '#form-merchantId .actions-container a[download]',
  verify: '#form-merchantId .actions-container button:has-text("Verify")',
} as const;

/**
 * Signals that the persisted session is no longer authenticated. Apple bounces
 * an expired session to a sign-in page rather than returning 401, so the only
 * way to detect it is to look at where we landed.
 */
export const SIGN_IN_URL_MARKERS = [
  '/auth/signin',
  'idmsa.apple.com',
  'appleid.apple.com/auth',
] as const;

/**
 * Best-effort prefill during the assisted `apple:login` flow. These are NOT on
 * the unattended path: a login is 2FA-gated and finished by a human, so a broken
 * selector here costs a manual field entry, never a failed run.
 */
export const SIGN_IN_SELECTORS = {
  /** Apple's sign-in widget renders inside an iframe on some entry points. */
  widgetFrame: 'iframe[id*="aid-auth-widget"], iframe[name*="aid-auth-widget"]',
  email: 'input#account_name_text_field',
  password: 'input#password_text_field',
  submit: 'button#sign-in',
} as const;

/**
 * Marks the merchant edit page as loaded. Waiting on the form rather than on a
 * network-idle heuristic is what makes the wait meaningful.
 */
export const MERCHANT_FORM_SELECTOR = '#form-merchantId';
