import { getDb } from '../src/server/db'
import { seedAdmin } from '../src/server/seed'

async function main() {
  const email = process.env.OPERATOR_EMAIL
  const password = process.env.OPERATOR_PASSWORD
  if (!email || !password) {
    console.error('Set OPERATOR_EMAIL and OPERATOR_PASSWORD to seed the first admin.')
    process.exit(1)
  }
  const r = await seedAdmin(getDb(), { email, password })
  console.log(r.created ? `Seeded admin ${email}` : `Admin ${email} already exists — no change.`)
  process.exit(0)
}

void main()
