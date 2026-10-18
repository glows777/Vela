import { feishu } from '../../../src/extensions/feishu/index.ts'
import { fauxHang, fauxText } from '../../../src/testing/faux.ts'
import { createTestVela } from '../../../src/testing/test-vela.ts'
import { fakeFeishu, feishuEvent } from '../../support/feishu.ts'

const [cwd, mode] = process.argv.slice(2)
const fake = fakeFeishu()
const ready = () => console.log('CRASH_READY')
if (mode === 'before-append')
  fake.transport.getSenderName = async () => {
    ready()
    return new Promise(() => {})
  }
if (mode === 'answer')
  fake.transport.reply = async () => {
    ready()
    return new Promise(() => {})
  }
const t = createTestVela({
  cwd,
  responses: [mode === 'answer' ? fauxText('saved answer') : fauxHang()],
  extensions: [
    feishu({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
  ],
})
await t.vela.ready()
await t.vela.startChannels()
fake.deliver(
  feishuEvent({
    message_id: 'trigger',
    root_id: 'root',
    thread_id: 'thread',
    content: '{"text":"remember cobalt"}',
  }),
)
if (mode === 'saved') {
  while (!t.model.calls.length) await Bun.sleep(1)
  await t.vela.session('feishu-oc_group-root').save()
  ready()
}
setInterval(() => {}, 1000)
