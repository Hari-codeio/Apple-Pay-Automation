import { z } from 'zod';
import { ConfigValidationError, parseEnv, validateEnv } from './core';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  SECRET: z.string().min(8),
});

describe('validateEnv', () => {
  it('returns the original env untouched when applyParsed is not set', () => {
    const env = { SECRET: 'supersecret', EXTRA: 'kept' };
    const result = validateEnv(schema, env, { strict: true });

    expect(result).toBe(env);
    // The schema defaults PORT, but without applyParsed the caller's env is
    // handed back byte-for-byte — no silent injection of defaults.
    expect(result.PORT).toBeUndefined();
  });

  it('merges parsed defaults and coercions over env when applyParsed is set', () => {
    const env = { SECRET: 'supersecret', PORT: '8080', EXTRA: 'kept' };
    const result = validateEnv(schema, env, {
      strict: true,
      applyParsed: true,
    });

    expect(result.PORT).toBe(8080); // coerced to a number
    expect(result.EXTRA).toBe('kept'); // unknown keys survive the merge
  });

  it('applies schema defaults for absent vars when applyParsed is set', () => {
    const result = validateEnv(
      schema,
      { SECRET: 'supersecret' },
      { strict: true, applyParsed: true },
    );

    expect(result.PORT).toBe(3000);
  });

  it('throws naming every offending var when strict', () => {
    expect(() =>
      validateEnv(schema, { SECRET: 'short' }, { strict: true }),
    ).toThrow(/SECRET/);
  });

  it('warns and continues when not strict', () => {
    const warn = jest.fn();
    const env = { SECRET: 'short' };

    const result = validateEnv(schema, env, { strict: false, warn });

    expect(result).toBe(env);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('log-only');
    expect(warn.mock.calls[0][0]).toContain('SECRET');
  });

  it('does not echo the offending value into the failure message', () => {
    const secret = 'leakme';
    let message = '';
    try {
      validateEnv(schema, { SECRET: secret }, { strict: true });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('SECRET');
    expect(message).not.toContain(secret);
  });
});

describe('parseEnv', () => {
  it('returns the parsed output', () => {
    expect(parseEnv(schema, { SECRET: 'supersecret', PORT: '9000' })).toEqual({
      SECRET: 'supersecret',
      PORT: 9000,
    });
  });

  it('throws a ConfigValidationError carrying structured issues', () => {
    expect.assertions(3);
    try {
      parseEnv(schema, {});
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const issues = (err as ConfigValidationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe('SECRET');
    }
  });
});
