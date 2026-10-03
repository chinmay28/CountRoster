// node --test scripts/licenses.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  androidGroupLicense,
  classify,
  gradleDependencies,
  isAllowed,
  npmComponents,
  renderNotices,
} from './licenses-lib.mjs';

const MIT = `Copyright (c) 2020 X\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software…`;
const BSD3 = `Redistribution and use in source and binary forms, with or without\nmodification, are permitted… Neither the name of Google Inc. nor the names…`;
const BSD2 = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that…`;
const ISC = `Permission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.`;
const ZERO_BSD = `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.\n\nTHE SOFTWARE IS PROVIDED "AS IS"…`;

test('classify recognizes the permissive licences by their text', () => {
  assert.equal(classify(MIT), 'MIT');
  assert.equal(classify(BSD3), 'BSD-3-Clause');
  assert.equal(classify(BSD2), 'BSD-2-Clause');
  assert.equal(classify(ISC), 'ISC');
  assert.equal(classify(ZERO_BSD), '0BSD');
  assert.equal(classify('Apache License\nVersion 2.0, January 2004'), 'Apache-2.0');
  assert.equal(classify('This is free and unencumbered software released into the public domain.'), 'Unlicense');
});

test('classify names copyleft so the failure says what it found', () => {
  assert.equal(classify('GNU GENERAL PUBLIC LICENSE Version 3'), 'GPL');
  assert.equal(classify('GNU LESSER GENERAL PUBLIC LICENSE'), 'LGPL');
  assert.equal(classify('GNU AFFERO GENERAL PUBLIC LICENSE'), 'AGPL');
  assert.equal(classify('Mozilla Public License Version 2.0'), 'MPL');
  assert.equal(classify('All rights reserved. Do not copy.'), null);
});

test('isAllowed reads SPDX expressions', () => {
  assert.ok(isAllowed('MIT'));
  assert.ok(isAllowed('(MIT OR GPL-3.0)'), 'a choice with one permissive side is fine');
  assert.ok(!isAllowed('MIT AND GPL-3.0'), 'both sides of AND bind');
  assert.ok(!isAllowed('GPL-3.0-only'));
  assert.ok(!isAllowed('LGPL-2.1'));
  assert.ok(!isAllowed(null));
  assert.ok(!isAllowed('UNLICENSED'), 'npm UNLICENSED means proprietary');
});

test('npmComponents keeps production packages only', () => {
  const lock = {
    packages: {
      '': { name: 'countroster' },
      'apps/web': { name: '@countroster/web' },
      'node_modules/@countroster/web': { link: true },
      'node_modules/react': { version: '18.3.1', license: 'MIT' },
      'node_modules/vitest': { version: '4.1.0', license: 'MIT', dev: true },
      'node_modules/a/node_modules/b': { version: '1.0.0', license: 'ISC' },
    },
  };
  assert.deepEqual(
    npmComponents(lock).map((c) => [c.name, c.license]),
    [['b', 'ISC'], ['react', 'MIT']],
  );
});

test('Android dependencies come from build.gradle.kts, and unknown groups fail', () => {
  const deps = gradleDependencies(`
dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    testImplementation("junit:junit:4.13.2")
    implementation("com.example:tracker-sdk:2.0")
}`);
  assert.deepEqual(deps.map((d) => d.group), ['androidx.core', 'com.example']);
  assert.equal(androidGroupLicense('androidx.core')?.license, 'Apache-2.0');
  assert.equal(androidGroupLicense('org.jetbrains.kotlin')?.license, 'Apache-2.0');
  assert.equal(androidGroupLicense('com.example'), null);
  assert.equal(androidGroupLicense('androidxevil'), null);
});

test('renderNotices groups by section and keeps every licence text', () => {
  const out = renderNotices([
    { section: 'Go', name: 'modernc.org/sqlite', version: 'v1.53.0', license: 'BSD-3-Clause', texts: [BSD3, 'third-party: MIT'] },
    { section: 'Web', name: 'react', version: '18.3.1', license: 'MIT', texts: [MIT] },
  ]);
  assert.match(out, /AGPL-3\.0-only/);
  assert.match(out, /modernc\.org\/sqlite v1\.53\.0 — BSD-3-Clause/);
  assert.match(out, /third-party: MIT/);
  assert.ok(out.indexOf('Go\n') < out.indexOf('Web\n'));
});
