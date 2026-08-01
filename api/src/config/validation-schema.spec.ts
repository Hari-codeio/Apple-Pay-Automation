import { configValidationSchema } from './validation-schema';

/**
 * A minimal env that passes on a dev-like tier. Each test starts from this and
 * changes one thing, so a failure names exactly one cause.
 */
const baseEnv = {
  DB_HOST: 'localhost',
  DB_NAME: 'phoenix_release',
  DB_USER: 'admin',
  DB_PASSWORD: 'local-password',
  APPLE_ID_EMAIL: 'ops@example.com',
  APPLE_ID_PASSWORD: 'local-password',
  APPLE_TEAM_ID: '64426BH9K3',
  APPLE_MERCHANT_ID: 'merchant.phoenix.applepay8',
};

/** The same env promoted to a shared tier, where the posture guards apply. */
const productionEnv = {
  ...baseEnv,
  ENVIRONMENT: 'production',
  NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  API_KEY: 'k'.repeat(32),
};

function parse(env: Record<string, unknown>) {
  return configValidationSchema.safeParse(env);
}

function issuePaths(env: Record<string, unknown>): string[] {
  const result = parse(env);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('defaults', () => {
  it('accepts a minimal dev-like env', () => {
    expect(parse(baseEnv).success).toBe(true);
  });

  it('applies runtime defaults', () => {
    const result = parse(baseEnv);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ENVIRONMENT).toBe('local');
    expect(result.data.PORT).toBe(3000);
    expect(result.data.LOG_LEVEL).toBe('info');
    expect(result.data.DB_PORT).toBe(3306);
    expect(result.data.TRUST_PROXY).toBe('1');
    expect(result.data.VERIFICATION_TTL_DAYS).toBe(365);
  });

  it('coerces numeric env strings to numbers', () => {
    const result = parse({ ...baseEnv, PORT: '8080', DB_PORT: '3307' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.PORT).toBe(8080);
    expect(result.data.DB_PORT).toBe(3307);
  });

  it('parses boolean env strings case-insensitively', () => {
    const result = parse({ ...baseEnv, LOG_PRETTY: 'TRUE', DB_SSL: 'false' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.LOG_PRETTY).toBe(true);
    expect(result.data.DB_SSL).toBe(false);
  });
});

describe('blank optional values', () => {
  // `FOO=` in a .env file arrives as '', which `.optional()` does not treat as
  // missing. Without the blank-as-undefined preprocessing, a commented-out-by-
  // emptying variable makes the service refuse to boot with "too small".
  it.each([
    ['API_KEY', 'API_KEY'],
    ['DB_SSL_CA_PATH', 'DB_SSL_CA_PATH'],
    ['CORS_ALLOWED_ORIGINS', 'CORS_ALLOWED_ORIGINS'],
    ['LOG_PRETTY', 'LOG_PRETTY'],
    ['SWAGGER_ENABLED', 'SWAGGER_ENABLED'],
    ['DB_SSL', 'DB_SSL'],
  ])('treats an empty %s as unset', (_label, key) => {
    const result = parse({ ...baseEnv, [key]: '' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[key as keyof typeof result.data]).toBeUndefined();
  });

  it('treats a whitespace-only value as unset', () => {
    expect(parse({ ...baseEnv, API_KEY: '   ' }).success).toBe(true);
  });

  it('still reports an empty API_KEY as REQUIRED on a shared tier', () => {
    // Blank means unset, and unset is refused there — the operator gets
    // "is required" rather than a confusing length complaint.
    const result = parse({ ...productionEnv, API_KEY: '' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.message).join(' ')).toContain(
      'API_KEY is required',
    );
  });
});

describe('required credentials', () => {
  it.each([
    'DB_HOST',
    'DB_NAME',
    'DB_USER',
    'DB_PASSWORD',
    'APPLE_ID_EMAIL',
    'APPLE_TEAM_ID',
    'APPLE_MERCHANT_ID',
  ])('refuses to boot without %s', (key) => {
    const env: Record<string, unknown> = { ...baseEnv };
    delete env[key];
    expect(issuePaths(env)).toContain(key);
  });

  it('boots WITHOUT an Apple ID password', () => {
    // The password is only best-effort prefill in the assisted `apple:login`.
    // The unattended flow authenticates with the saved session or the persistent
    // browser profile, so requiring it here would block a perfectly valid setup
    // where the browser profile is already signed in.
    const env: Record<string, unknown> = { ...baseEnv };
    delete env.APPLE_ID_PASSWORD;
    expect(parse(env).success).toBe(true);
  });

  it('still rejects a placeholder Apple ID password when one is given', () => {
    expect(
      issuePaths({ ...baseEnv, APPLE_ID_PASSWORD: 'REPLACE_ME' }),
    ).toContain('APPLE_ID_PASSWORD');
  });

  it('rejects an empty string as a supplied credential', () => {
    // z.string() alone accepts '', which would boot with no password at all.
    expect(issuePaths({ ...baseEnv, DB_PASSWORD: '' })).toContain(
      'DB_PASSWORD',
    );
  });
});

describe('placeholder sentinels', () => {
  it.each([
    ['REPLACE_ME', 'REPLACE_ME'],
    ['CHANGEME', 'CHANGEME'],
    ['YOUR_PASSWORD', 'YOUR_PASSWORD'],
    ['angle-bracket marker', '<DB_PASSWORD>'],
  ])('rejects a value left as %s', (_label, value) => {
    // Guards against `cp .env.example .env` producing a service that boots and
    // then drives the portal with template values.
    expect(issuePaths({ ...baseEnv, DB_PASSWORD: value })).toContain(
      'DB_PASSWORD',
    );
  });

  it('does not trip on a legitimate lowercase value', () => {
    expect(
      parse({ ...baseEnv, DB_PASSWORD: 'your_real_password' }).success,
    ).toBe(true);
  });
});

describe('Apple identifier shapes', () => {
  it.each(['64426bh9k3', '64426BH9K', '64426BH9K33', ''])(
    'rejects team id %p',
    (value) => {
      expect(issuePaths({ ...baseEnv, APPLE_TEAM_ID: value })).toContain(
        'APPLE_TEAM_ID',
      );
    },
  );

  it.each(['phoenix.applepay8', 'merchant', 'Merchant.phoenix'])(
    'rejects merchant id %p',
    (value) => {
      expect(issuePaths({ ...baseEnv, APPLE_MERCHANT_ID: value })).toContain(
        'APPLE_MERCHANT_ID',
      );
    },
  );

  it('rejects a malformed Apple ID email', () => {
    expect(
      issuePaths({ ...baseEnv, APPLE_ID_EMAIL: 'not-an-email' }),
    ).toContain('APPLE_ID_EMAIL');
  });
});

describe('browser selection', () => {
  it('defaults to Playwright bundled Chromium with a throwaway profile', () => {
    const result = parse(baseEnv);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.BROWSER_CHANNEL).toBe('chromium');
    expect(result.data.BROWSER_USER_DATA_DIR).toBeUndefined();
  });

  it.each(['chromium', 'chrome', 'msedge'])(
    'accepts browser channel %s',
    (channel) => {
      expect(parse({ ...baseEnv, BROWSER_CHANNEL: channel }).success).toBe(
        true,
      );
    },
  );

  it('rejects an unknown browser channel', () => {
    // Playwright only downloads 'chromium'; a typo'd branded channel would
    // otherwise fail at launch instead of at boot.
    expect(issuePaths({ ...baseEnv, BROWSER_CHANNEL: 'firefox' })).toContain(
      'BROWSER_CHANNEL',
    );
  });

  it('accepts a persistent profile directory', () => {
    const result = parse({
      ...baseEnv,
      BROWSER_CHANNEL: 'chrome',
      BROWSER_USER_DATA_DIR: '.playwright/chrome-profile',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.BROWSER_USER_DATA_DIR).toBe(
      '.playwright/chrome-profile',
    );
  });
});

describe('shared-tier security posture', () => {
  it('accepts a fully-configured production env', () => {
    expect(parse(productionEnv).success).toBe(true);
  });

  it('requires an API key outside dev-like tiers', () => {
    const env: Record<string, unknown> = { ...productionEnv };
    delete env.API_KEY;
    expect(issuePaths(env)).toContain('API_KEY');
  });

  it('requires an API key of at least 32 characters', () => {
    expect(issuePaths({ ...productionEnv, API_KEY: 'short' })).toContain(
      'API_KEY',
    );
  });

  it('requires a CORS allowlist outside dev-like tiers', () => {
    const env: Record<string, unknown> = { ...productionEnv };
    delete env.CORS_ALLOWED_ORIGINS;
    expect(issuePaths(env)).toContain('CORS_ALLOWED_ORIGINS');
  });

  it('rejects a wildcard CORS allowlist outside dev-like tiers', () => {
    expect(
      issuePaths({ ...productionEnv, CORS_ALLOWED_ORIGINS: '*' }),
    ).toContain('CORS_ALLOWED_ORIGINS');
  });

  it('rejects a CORS entry carrying a path', () => {
    expect(
      issuePaths({
        ...productionEnv,
        CORS_ALLOWED_ORIGINS: 'https://app.example.com/callback',
      }),
    ).toContain('CORS_ALLOWED_ORIGINS');
  });

  it('rejects Swagger in production', () => {
    expect(issuePaths({ ...productionEnv, SWAGGER_ENABLED: 'true' })).toContain(
      'SWAGGER_ENABLED',
    );
  });

  it('rejects disabling database TLS outside dev-like tiers', () => {
    expect(issuePaths({ ...productionEnv, DB_SSL: 'false' })).toContain(
      'DB_SSL',
    );
  });

  it('rejects pretty logging outside dev-like tiers', () => {
    // pino-pretty is a devDependency, absent from the pruned production image,
    // so enabling this there would crash the logger at first write.
    expect(issuePaths({ ...productionEnv, LOG_PRETTY: 'true' })).toContain(
      'LOG_PRETTY',
    );
  });

  it('rejects a headed browser outside dev-like tiers', () => {
    // There is no display server on a shared tier, so the run would hang at
    // launch rather than fail loudly.
    expect(
      issuePaths({ ...productionEnv, PLAYWRIGHT_HEADLESS: 'false' }),
    ).toContain('PLAYWRIGHT_HEADLESS');
  });

  it('rejects switching the boot gate to log-only outside dev-like tiers', () => {
    expect(
      issuePaths({ ...productionEnv, CONFIG_VALIDATION_LOG_ONLY: 'true' }),
    ).toContain('CONFIG_VALIDATION_LOG_ONLY');
  });

  it('permits all of the above on a dev-like tier', () => {
    const result = parse({
      ...baseEnv,
      ENVIRONMENT: 'local',
      DB_SSL: 'false',
      PLAYWRIGHT_HEADLESS: 'false',
      SWAGGER_ENABLED: 'true',
      CONFIG_VALIDATION_LOG_ONLY: 'true',
    });
    expect(result.success).toBe(true);
  });

  it('treats sandbox as a shared tier, not a dev-like one', () => {
    // sandbox is prod-shaped by design; relaxing it would defeat the point.
    const env: Record<string, unknown> = {
      ...productionEnv,
      ENVIRONMENT: 'sandbox',
    };
    delete env.API_KEY;
    expect(issuePaths(env)).toContain('API_KEY');
  });
});
