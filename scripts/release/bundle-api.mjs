import { createRequire } from 'node:module';
import { cp, mkdir, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson } from './generate-metadata.mjs';

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function locate(source, directory, name) {
  for (const entry of modulePaths(directory)) {
    if (!inside(source, entry)) continue;
    try {
      const candidate = await realpath(path.join(entry, name));
      if (!inside(source, candidate)) throw new Error('An API dependency leaves the staged runtime.');
      await readFile(path.join(candidate, 'package.json'));
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function modulePaths(directory) {
  // Supply a non-builtin specifier so names like string_decoder retain the
  // package search path when a dependency imports string_decoder/.
  return createRequire(path.join(directory, 'package.json')).resolve.paths('aria-bundled-package');
}

export async function bundleApi(source, destination) {
  // Preserve the already staged dependency graph. pnpm's virtual-store links
  // cannot be carried through an NSIS archive, so materialize the Node layout.
  source = await realpath(source);
  destination = path.resolve(destination);
  await mkdir(destination, { recursive: true });
  await Promise.all(['dist', 'package.json'].map((name) =>
    cp(path.join(source, name), path.join(destination, name), { recursive: true })));

  const installed = new Map();
  const queue = [{ origin: source, directory: destination }];
  for (const { origin, directory } of queue) {
    const manifest = await readJson(path.join(origin, 'package.json'));
    const dependencies = {
      ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies,
    };
    for (const name of Object.keys(dependencies)) {
      const dependency = await locate(source, origin, name);
      if (!dependency) {
        if (manifest.optionalDependencies?.[name] || manifest.peerDependencies?.[name]) continue;
        throw new Error(`Missing staged API dependency ${name} required by ${manifest.name}.`);
      }
      const search = modulePaths(directory)
        .filter((entry) => inside(destination, entry)).map((entry) => path.join(entry, name));
      const visible = search.find((entry) => installed.has(entry));
      if (visible && installed.get(visible) === dependency) continue;
      const slot = visible ? search[0] : search.at(-1);
      if (!slot || installed.has(slot) || queue.length > 1500)
        throw new Error(`Could not reproduce the staged API dependency tree for ${name}.`);
      installed.set(slot, dependency);
      queue.push({ origin: dependency, directory: slot });
    }
  }

  await Promise.all([...installed].map(async ([directory, origin]) => {
    await mkdir(directory, { recursive: true });
    await cp(origin, directory, {
      recursive: true,
      filter: (entry) => !path.relative(origin, entry).split(path.sep).includes('node_modules'),
      dereference: true,
    });
  }));
}
