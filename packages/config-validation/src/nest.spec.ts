import { z } from 'zod';
import { isStrictConfigValidation, makeValidateEnv } from './nest';

const schema = z.object({
  SECRET: z.string().min(8),
  PORT: z.coerce.number().int().positive().default(3000),
});

describe('isStrictConfigValidation', () => {
  it('is strict by default — an unset flag must not weaken the boot gate', () => {
    expect(isStrictConfigValidation({})).toBe(true);
  });

  it('stays strict for any value other than the exact opt-out string', () => {
    expect(isStrictConfigValidation({ CONFIG_VALIDATION_LOG_ONLY: '1' })).toBe(
      true,
    );
    expect(
      isStrictConfigValidation({ CONFIG_VALIDATION_LOG_ONLY: 'TRUE' }),
    ).toBe(true);
    expect(
      isStrictConfigValidation({ CONFIG_VALIDATION_LOG_ONLY: 'false' }),
    ).toBe(true);
  });

  it('downgrades to log-only on the explicit operator opt-out', () => {
    expect(
      isStrictConfigValidation({ CONFIG_VALIDATION_LOG_ONLY: 'true' }),
    ).toBe(false);
  });
});

describe('makeValidateEnv', () => {
  it('throws at boot on an invalid env', () => {
    const validate = makeValidateEnv(schema);

    expect(() => validate({ SECRET: 'short' })).toThrow(/SECRET/);
  });

  it('returns env unchanged on success without applyParsed', () => {
    const validate = makeValidateEnv(schema);
    const env = { SECRET: 'supersecret' };

    expect(validate(env)).toBe(env);
  });

  it('returns defaults and coercions with applyParsed', () => {
    const validate = makeValidateEnv(schema, { applyParsed: true });

    expect(validate({ SECRET: 'supersecret' })).toMatchObject({ PORT: 3000 });
  });

  it('honours the log-only opt-out carried in the validated env itself', () => {
    const validate = makeValidateEnv(schema);

    // Strictness is resolved from the env object Nest hands the validator, not
    // from process.env, so a per-environment configmap value takes effect.
    expect(() =>
      validate({ SECRET: 'short', CONFIG_VALIDATION_LOG_ONLY: 'true' }),
    ).not.toThrow();
  });
});
