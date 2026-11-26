import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SNAPSHOT_NPM_TAG = 'snapshot';

const OWN_PREFIX = '@builtbyfriends/realtime';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

type Dependencies = Record<string, string>;

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Dependencies;
  devDependencies?: Dependencies;
  peerDependencies?: Dependencies;
  optionalDependencies?: Dependencies;
};

export function snapshotVersion(base: string, change: string, sha: string, baseIsReleased = false): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(base);

  if (!match) {
    throw new Error(`${base} is not a version to build a snapshot from.`);
  }

  if (!/^[a-z0-9]+$/.test(change) || /^0\d/.test(change)) {
    throw new Error(`${change} is not a pull request number or a plain label.`);
  }

  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`${sha} is not a commit id.`);
  }

  const [major, minor, patch] = match.slice(1).map(Number);

  return `${major}.${minor}.${baseIsReleased ? (patch ?? 0) + 1 : patch}-snap.${change}.g${sha.slice(0, 7)}`;
}

function isManifest(value: unknown): value is Manifest {
  return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string' && 'version' in value && typeof value.version === 'string';
}

function readManifest(url: URL): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'));

  if (!isManifest(parsed)) {
    throw new Error(`${url.pathname} has no name and version.`);
  }

  return parsed;
}

export function withSnapshotVersion(manifest: Manifest, version: string): Manifest {
  const next: Manifest = { ...manifest, version };

  for (const field of DEPENDENCY_FIELDS) {
    const section = manifest[field];

    if (section) {
      next[field] = Object.fromEntries(
        Object.entries(section).map(([name, range]) => [name, name === OWN_PREFIX || name.startsWith(`${OWN_PREFIX}-`) ? version : range]),
      );
    }
  }

  return next;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = new URL('../packages/', import.meta.url);

  const manifests = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => new URL(`${encodeURIComponent(name)}/package.json`, root))
    .map((url) => ({ url, manifest: readManifest(url) }))
    .filter(({ manifest }) => !manifest.private);

  const core = manifests.find(({ manifest }) => manifest.name === OWN_PREFIX);

  if (!core) {
    throw new Error(`The snapshot must include ${OWN_PREFIX}.`);
  }

  const released = execFileSync('git', ['tag', '--list', `v${core.manifest.version}`], { encoding: 'utf8' }).trim() !== '';
  const version = snapshotVersion(core.manifest.version, process.env.SNAPSHOT_CHANGE ?? '', process.env.SNAPSHOT_SHA ?? '', released);

  for (const { url, manifest } of manifests) {
    writeFileSync(url, `${JSON.stringify(withSnapshotVersion(manifest, version), null, 2)}\n`);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nnpm-tag=${SNAPSHOT_NPM_TAG}\n`);
  }

  console.log(`Snapshot ${version} for ${manifests.length} packages; npm tag: ${SNAPSHOT_NPM_TAG}.`);
}
