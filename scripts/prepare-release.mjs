import { cp, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const musicSource = resolve('音乐资源');
const docsSource = resolve('docs');
const readmeSource = resolve('README.md');
const targets = [
  resolve('release'),
  resolve('release', 'win-unpacked'),
];

await Promise.all([stat(musicSource), stat(docsSource), stat(readmeSource)]);
for (const releaseRoot of targets) {
  const musicTarget = resolve(releaseRoot, '音乐资源');
  await mkdir(musicTarget, { recursive: true });
  // 合并复制，不删除用户已经放进发布目录的歌曲。
  await cp(musicSource, musicTarget, { recursive: true, force: true });
  await cp(docsSource, resolve(releaseRoot, 'docs'), { recursive: true, force: true });
  await cp(readmeSource, resolve(releaseRoot, 'README.md'), { force: true });
  console.log(`  [music-resource] ${musicTarget}`);
  console.log(`  [documentation] ${resolve(releaseRoot, 'docs')}`);
}
