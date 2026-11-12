// EmailApp — `log` transport stand-in for one mounted email secret
// (PLAN §4 shape: {type: "log", from, generation}). "Sending" = one JSON log line,
// so drills can grep deliveries. A generation change swaps the from-address.
import { FileDep } from "./filedep.ts";

export type EmailSecret = { type: "log"; from: string; generation: number };

export class EmailApp {
  private dep: FileDep<EmailSecret>;

  constructor(secretPath: string, pollMs = 2000) {
    this.dep = new FileDep<EmailSecret>(secretPath, (prev, cur) => {
      if (prev && cur.generation !== prev.generation) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), evt: "email-generation", from: cur.from, generation: cur.generation }));
      }
    }, pollMs);
  }

  start() {
    this.dep.start();
  }
  stop() {
    this.dep.stop();
  }

  get ready(): boolean {
    return this.dep.ready;
  }

  send(m: { to: string; subject: string; text: string }): void {
    const s = this.dep.current;
    if (!s) throw new Error("email not ready");
    if (s.type !== "log") throw new Error(`email transport ${s.type} not supported`);
    console.log(JSON.stringify({ ts: new Date().toISOString(), evt: "email", from: s.from, to: m.to, subject: m.subject, text: m.text }));
  }
}
