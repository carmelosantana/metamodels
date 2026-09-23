import { main } from './commands.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: (s) => { process.stdout.write(s) },
  stderr: (s) => { process.stderr.write(s) },
  readStdin,
})
