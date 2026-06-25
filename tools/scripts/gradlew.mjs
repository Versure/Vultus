import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const androidDir = resolve('android');
// Node v22+ (CVE-2024-27980) requires shell:true to spawn .bat files on Windows
const wrapper =
  process.platform === 'win32'
    ? resolve(androidDir, 'gradlew.bat')
    : './gradlew';

execFileSync(wrapper, process.argv.slice(2), {
  cwd: androidDir,
  shell: true,
  stdio: 'inherit',
});
