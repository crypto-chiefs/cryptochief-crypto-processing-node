import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/client';

// The version lives in two places and nothing used to compare them. They drifted
// once already: 0.4.0 shipped announcing itself to the API as an older number,
// so every request from that release was attributed to a version that had not
// been published in months. The manifest is the source of truth; this is the
// thing that notices when the constant is left behind.
describe('VERSION', () => {
  it('matches the published package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});
