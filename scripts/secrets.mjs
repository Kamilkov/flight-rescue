// The secrets a script or the app needs, and nothing more, from ~/.config/ai/secrets.env (or SECRETS_FILE). The file is
// parsed as dotenv data inside this process: never sourced, never exported as a whole, values never printed. For each
// name, the first place that has it decides, in this order: the environment, the project entry FLIGHT_RESCUE__<NAME>,
// the shared <NAME>. An empty value there is missing; it never falls back to the next place.
//   in a script:   const { SAP_USER, SAP_PASSWORD } = secrets('SAP_USER', 'SAP_PASSWORD')
//   for a command: node scripts/secrets.mjs SAP_USER SAP_PASSWORD -- npx cds-serve
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const FILE = process.env.SECRETS_FILE ?? `${process.env.HOME}/.config/ai/secrets.env`
const PROJECT = 'FLIGHT_RESCUE'

/** The named secrets as { NAME: value }. Throws if one is missing or empty, naming the exact variable that was missing
 *  or empty (never a value), so a caller that asks first fails before it changes anything. */
export function secrets(...names) {
  let file = {}, absent = ''
  try { file = parseEnv(readFileSync(FILE, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e; absent = ', which does not exist' }
  const values = {}, missing = []
  for (const n of names) {
    const project = `${PROJECT}__${n}`
    const [where, value] = n in process.env ? [`${n} in the environment`, process.env[n]]
      : project in file ? [`${project} in ${FILE}`, file[project]]
      : n in file ? [`${n} in ${FILE}`, file[n]]
      : [`${n} (in neither the environment nor ${FILE}${absent})`, '']
    if (value) values[n] = value
    else missing.push(where)
  }
  if (missing.length) throw new Error(`Missing or empty secret: ${missing.join('; ')}.`)
  return values
}

// As a command: runs what follows `--` with only the named secrets added to its environment.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dash = process.argv.indexOf('--')
  if (dash < 3 || dash === process.argv.length - 1) {
    console.error('Use: node scripts/secrets.mjs NAME… -- command args…')
    process.exit(1)
  }
  let env
  try { env = { ...process.env, ...secrets(...process.argv.slice(2, dash)) } } catch (e) { console.error(e.message); process.exit(1) }
  const [command, ...args] = process.argv.slice(dash + 1)
  const child = spawn(command, args, { stdio: 'inherit', env })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}
