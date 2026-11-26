import { describe, expect, it } from 'vitest';
import { snapshotVersion, withSnapshotVersion } from '../../../scripts/snapshot-version.ts';

describe('snapshot versions', () => {
  it('names the next release when the base version is already released', () => {
    expect(snapshotVersion('0.11.0', '41', 'a1b2c3d4e5f6', true)).toBe('0.11.1-snap.41.ga1b2c3d');
  });

  it('keeps the base version when a pull request bumps it', () => {
    expect(snapshotVersion('0.12.0', '41', 'a1b2c3d4e5f6')).toBe('0.12.0-snap.41.ga1b2c3d');
  });

  it('keeps an all-digit commit id a valid prerelease part', () => {
    expect(snapshotVersion('0.11.0', '41', '0123456789ab', true)).toBe('0.11.1-snap.41.g0123456');
  });

  it.each([['0.11', '41', 'abcdef1'], ['0.11.0', '041', 'abcdef1'], ['0.11.0', '41', 'xyz']])('refuses %s, %s, %s', (base, change, sha) => {
    expect(() => snapshotVersion(base, change, sha)).toThrow();
  });

  it('moves the exact versions the packages ask of each other, and leaves the rest', () => {
    const manifest = {
      name: '@builtbyfriends/realtime-live',
      version: '0.11.0',
      dependencies: { '@builtbyfriends/realtime': '0.11.0', '@builtbyfriends/realtime-http': '0.11.0', zod: '^4.6.7' },
      peerDependencies: { '@builtbyfriends/bwf': '^1.13.8' },
    };
    const next = withSnapshotVersion(manifest, '0.11.1-snap.41.ga1b2c3d');

    expect(next.version).toBe('0.11.1-snap.41.ga1b2c3d');
    expect(next.dependencies).toEqual({
      '@builtbyfriends/realtime': '0.11.1-snap.41.ga1b2c3d',
      '@builtbyfriends/realtime-http': '0.11.1-snap.41.ga1b2c3d',
      zod: '^4.6.7',
    });
    expect(next.peerDependencies).toEqual({ '@builtbyfriends/bwf': '^1.13.8' });
  });
});
