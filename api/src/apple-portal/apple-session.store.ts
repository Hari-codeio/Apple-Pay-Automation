import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Persistence for the authenticated Apple portal browser session.
 *
 * Apple ID sign-in is 2FA-gated, so a password alone cannot produce an
 * unattended run — the SESSION is the credential. `pnpm apple:login` opens a
 * real browser, a human completes 2FA once, and the resulting cookies land here
 * for every later run to reuse.
 *
 * The file is a bearer credential for the whole Apple Developer account. It is
 * written 0600 and belongs nowhere near version control (`.playwright/` is
 * gitignored).
 */
@Injectable()
export class AppleSessionStore {
  constructor(private readonly config: ConfigService) {}

  path(): string {
    return resolve(
      process.cwd(),
      this.config.getOrThrow<string>('APPLE_SESSION_STATE_PATH'),
    );
  }

  /** Raw storageState JSON, or undefined when absent or unreadable. */
  async read(): Promise<string | undefined> {
    try {
      const content = await readFile(this.path(), 'utf8');
      // An empty or truncated file is worse than a missing one: Playwright
      // throws deep inside context creation instead of at our own guard.
      JSON.parse(content);
      return content;
    } catch {
      return undefined;
    }
  }

  async write(state: unknown): Promise<void> {
    const target = this.path();
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    // mode on writeFile only applies at creation, so an existing file keeps its
    // old permissions. Set them explicitly on every write.
    // chmod is a no-op on Windows; the ACL there already limits the file to the
    // owning user's profile directory.
    await chmod(target, 0o600).catch(() => undefined);
  }
}
