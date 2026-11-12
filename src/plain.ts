// Plain application SQL: relative adds, database serial ids, and a three-statement transfer.
// No retry, request keys, deduplication tables, or ON CONFLICT in this workload.
import type { Z2Db } from "./lib/z2lib";
export const PLAIN_SCHEMA = [
  "create table if not exists plain_acct (id int primary key, bal bigint not null default 0, n bigint not null default 0)",
  "create table if not exists plain_ev (id bigserial primary key, acct int not null, amt bigint not null)",
  "create table if not exists plain_xfer (id bigserial primary key, src int not null, dst int not null, amt bigint not null)"
];
const server = "inet_server_addr()::text as server, current_database() as db";
export async function plainWrite(db: Z2Db, body: any) {
  const { op, a, b, amt } = body;
  if (!["ADD", "INS", "XFER"].includes(op) || !Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(amt) || amt < 1 || amt > 1000) throw new Error("invalid plain write");
  if (op === "XFER" && (!Number.isSafeInteger(b) || b <= a)) throw new Error("transfer needs a < b");
  if (op === "ADD") {
    const r = await db.query(`update plain_acct set bal=bal+$2, n=n+1 where id=$1 returning id, ${server}`, [a, amt]);
    if (r.rowCount !== 1) throw new Error("account missing");
    return { op, ...r.rows[0], id: null };
  }
  if (op === "INS") {
    const r = await db.query(`insert into plain_ev(acct,amt) values($1,$2) returning id, ${server}`, [a, amt]);
    return { op, ...r.rows[0] };
  }
  return db.begin(async tx => {
    const left = await tx.query("update plain_acct set bal=bal-$2, n=n+1 where id=$1", [a, amt]);
    if (left.rowCount !== 1) throw new Error("source account missing");
    if (body.delayMs) await Bun.sleep(Math.max(0, Math.min(5000, Number(body.delayMs))));
    const right = await tx.query("update plain_acct set bal=bal+$2, n=n+1 where id=$1", [b, amt]);
    if (right.rowCount !== 1) throw new Error("target account missing");
    const r = await tx.query(`insert into plain_xfer(src,dst,amt) values($1,$2,$3) returning id, ${server}`, [a, b, amt]);
    return { op, ...r.rows[0] };
  });
}
export async function plainSnapshot(db: Z2Db, base: number, count: number) {
  const p = [base, base + count];
  const accounts = (await db.read("select * from plain_acct where id >= $1 and id < $2 order by id", p)).rows;
  const events = (await db.read("select * from plain_ev where acct >= $1 and acct < $2 order by id", p)).rows;
  const transfers = (await db.read("select * from plain_xfer where src >= $1 and src < $2 order by id", p)).rows;
  const identity = (await db.read("select inet_server_addr()::text as server, current_database() as db")).rows[0];
  return { accounts, events, transfers, identity };
}

