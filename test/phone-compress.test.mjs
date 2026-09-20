import test from 'node:test';
import assert from 'node:assert/strict';
import { compressForSpeech } from '../src/phone-audio.mjs';

const longText = '构建系统在第三次重试后终于完成了全部编译任务，43项单元测试全部通过，但是静态检查发现了两个高危警告，一个在数据库迁移脚本的第42行，涉及未参数化的SQL拼接，另一个在认证模块，涉及硬编码的测试密钥，建议尽快修复，另外部署文档还没有更新。';

test('短文本原样播报，不压缩', async () => {
  const { spokenText, compressed } = await compressForSpeech('构建通过了。');
  assert.equal(spokenText, '构建通过了。');
  assert.equal(compressed, false);
});

test('无 LLM 端点时按句界截断到 100 字以内', async () => {
  const { spokenText, compressed } = await compressForSpeech(longText, { endpoint: '' });
  assert.equal(compressed, true);
  assert.ok(spokenText.length <= 100, `截断后超长：${spokenText.length}`);
  assert.match(spokenText, /…$|。$/);
});

test('LLM 端点可用时使用压缩结果', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.match(body.messages[0].content, /压缩到100字以内/);
    return new Response(JSON.stringify({ choices: [{ message: { content: '构建与测试通过。需决策：是否修复两个高危警告。' } }] }), { status: 200 });
  };
  const { spokenText, compressed } = await compressForSpeech(longText, { endpoint: 'http://fake/v1/chat/completions', fetchImpl });
  assert.equal(spokenText, '构建与测试通过。需决策：是否修复两个高危警告。');
  assert.equal(compressed, true);
});

test('LLM 端点失败时回退到截断', async () => {
  const fetchImpl = async () => { throw new Error('连接失败'); };
  const { spokenText, compressed } = await compressForSpeech(longText, { endpoint: 'http://fake/v1/chat/completions', fetchImpl });
  assert.equal(compressed, true);
  assert.ok(spokenText.length <= 100);
});

test('LLM 返回超长时仍收敛到 100 字以内', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: longText } }] }), { status: 200 });
  const { spokenText } = await compressForSpeech(longText, { endpoint: 'http://fake/v1/chat/completions', fetchImpl });
  assert.ok(spokenText.length <= 100);
});
