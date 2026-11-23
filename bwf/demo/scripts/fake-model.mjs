// Decision: a scripted stand-in for the Anthropic Messages API, so the demo's assistant runs without an
// API key. Set ANTHROPIC_API_KEY and leave ANTHROPIC_BASE_URL alone to talk to Claude instead.
import { createServer } from 'node:http';

let n = 0;
const reply = (content, stop_reason, messages) => ({
  id: `msg_demo_${++n}`, type: 'message', role: 'assistant', model: 'scripted-stand-in', content, stop_reason,
  usage: { input_tokens: 180 + JSON.stringify(messages).length / 4 | 0, output_tokens: 20 + JSON.stringify(content).length / 6 | 0 },
});
const tool = (name, input) => ({ type: 'tool_use', id: `toolu_demo_${++n}`, name, input });
const text = (t) => ({ type: 'text', text: t });

function script(body) {
  const { messages, system } = body;
  const first = typeof messages[0].content === 'string' ? messages[0].content : '';
  const org = /organization (\w+)/.exec(system)?.[1] ?? 'o1';
  const results = messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []));
  const last = results.at(-1);
  const add = /Add (.+?) \((\S+@\S+)\)/.exec(first);
  if (add) {
    const [, name, email] = add;
    const surname = name.split(' ').pop();
    if (results.length === 0) {return [[text(`I'll check whether ${name} is already a contact.`), tool('contacts_search', { orgId: org, query: surname })], 'tool_use'];}
    if (results.length === 1) {return [[text(`No contact named ${surname} yet, so I'll add them.`), tool('contacts_create', { orgId: org, name, email })], 'tool_use'];}
    const made = JSON.parse(last.content);
    return [[text(last.is_error ? `I couldn't add ${name}: ${made.error?.message ?? last.content}.` : `Done. ${name} is saved as contact ${made.id} with ${email}.`)], 'end_turn'];
  }
  if (/org o1/.test(first)) {
    if (results.length === 0) {return [[tool('contacts_search', { orgId: 'o1', query: 'a' })], 'tool_use'];}
    return [[text(last.is_error ? 'I can\'t see organization o1. Your token only has access to your own organization.' : 'Here they are.')], 'end_turn'];
  }
  return [[text('I can search and add contacts. What do you need?')], 'end_turn'];
}

export function startFakeModel(port = 0) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.endsWith('/v1/messages')) { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw);
      const [content, stop] = script(body);
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply(content, stop, body.messages))), 120 + Math.random() * 200);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startFakeModel(Number(process.env.PORT ?? 8788));
  console.log(`Scripted model at ${url}  (set ANTHROPIC_BASE_URL=${url})`);
}
