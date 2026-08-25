import './registerEnvDefaults.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadCaseById } from '../src/models/caseModel.js';
import {
  FEEDBACK_MAX_OUTPUT_TOKENS,
  buildFeedbackUserMessage,
  generateFeedback,
  loadFeedbackSystemPrompt,
  normalizeFeedbackResult,
} from '../src/services/feedbackService.js';

const baseCase = loadCaseById('case-1-david-leung');
const turns = [
  { index: 0, role: 'student', text: 'Stop your medicine; it is dangerous.', source: 'typed' },
  { index: 1, role: 'patient', text: 'That worries me. I want to check first.', tone: 'judgmental', generation: { recovered: false } },
];

function assessedItems(items, firstStatus = 'met') {
  return items.map((item, index) => {
    const status = index === 0 ? firstStatus : 'missed';
    return {
      id: item.id,
      label: item.label,
      status,
      evidence: status === 'met' ? 'The student clearly addressed this criterion.' : 'No relevant transcript evidence was found.',
      gap: status === 'met' ? null : 'The student did not address this criterion.',
    };
  });
}

function rawFor(caseConfig, overrides = {}) {
  return {
    status: 'complete',
    domains: assessedItems(caseConfig.consultation.domains),
    communicationSkills: assessedItems(caseConfig.assessment.communicationSkills, 'partial').map((item, index) => (
      index === 0 ? { ...item, gap: 'Empathy was attempted but the unsafe advice undermined it.' } : item
    )),
    overallComment: 'Advising the patient to stop prescribed medicine was unsafe.',
    improvementTips: ['Explain that prescribed medicine should continue and use collaborative language.'],
    reflectionQuestions: caseConfig.assessment.reflectionQuestions,
    ...overrides,
  };
}

function provider(outputs) {
  const calls = [];
  return {
    calls,
    async complete(input) {
      calls.push(input);
      const output = outputs[Math.min(calls.length - 1, outputs.length - 1)];
      if (output instanceof Error) throw output;
      return { rawText: output };
    },
  };
}

describe('feedback service', () => {
  it('uses one projected context and one authoritative transcript', async () => {
    const llmProvider = provider([JSON.stringify(rawFor(baseCase))]);
    const result = await generateFeedback({
      caseConfig: baseCase, turns, startedAt: '2026-08-20T01:00:00.000Z', endedAt: '2026-08-20T01:05:00.000Z', llmProvider,
    });
    const request = llmProvider.calls[0];
    assert.equal(request.responseIntent, 'feedback');
    assert.equal(request.maxOutputTokens, FEEDBACK_MAX_OUTPUT_TOKENS);
    assert.equal(request.messages.length, 1);
    assert.equal(request.messages[0].content.split('Stop your medicine; it is dangerous.').length - 1, 1);
    assert.match(request.messages[0].content, /studentObjectives|communicationSkills|reflectionQuestions/);
    assert.equal(request.messages[0].content.includes('voiceId'), false);
    assert.equal(request.messages[0].content.includes('maxStudentTurns'), false);
    assert.equal(result.status, 'complete');
    assert.equal(result.domains.length, 7);
    assert.equal(result.communicationSkills.length, 5);
  });

  it('supports arbitrary domain and communication-skill counts', async () => {
    const synthetic = structuredClone(baseCase);
    synthetic.consultation.domains = synthetic.consultation.domains.slice(0, 2);
    synthetic.assessment.communicationSkills = synthetic.assessment.communicationSkills.slice(0, 1);
    const result = await generateFeedback({
      caseConfig: synthetic, turns: [], llmProvider: provider([JSON.stringify(rawFor(synthetic))]),
    });
    assert.equal(result.domains.length, 2);
    assert.equal(result.communicationSkills.length, 1);
  });

  it('enforces authoritative labels and reflection questions', () => {
    const raw = rawFor(baseCase);
    raw.domains[0].label = 'Tampered label';
    raw.communicationSkills[0].label = 'Tampered skill';
    raw.reflectionQuestions = ['Tampered question'];
    const result = normalizeFeedbackResult(raw, baseCase);
    assert.equal(result.domains[0].label, baseCase.consultation.domains[0].label);
    assert.equal(result.communicationSkills[0].label, baseCase.assessment.communicationSkills[0].label);
    assert.deepEqual(result.reflectionQuestions, baseCase.assessment.reflectionQuestions);
  });

  it('uses a second completion to repair invalid output', async () => {
    const rejected = 'Assessment: everything went well.';
    const llmProvider = provider([rejected, JSON.stringify(rawFor(baseCase))]);
    const result = await generateFeedback({ caseConfig: baseCase, turns, llmProvider });
    assert.equal(result.status, 'complete');
    assert.equal(llmProvider.calls.length, 2);
    assert.match(llmProvider.calls[1].systemPrompt, /Output repair/);
    assert.match(llmProvider.calls[1].messages.at(-1).content, /everything went well/);
  });

  it('returns unavailable after two invalid outputs or two provider failures', async () => {
    for (const llmProvider of [provider(['bad']), provider([new Error('network')])]) {
      const result = await generateFeedback({ caseConfig: baseCase, turns, llmProvider });
      assert.equal(llmProvider.calls.length, 2);
      assert.deepEqual(result, {
        status: 'unavailable',
        message: 'Feedback could not be generated because of a technical error.',
        reflectionQuestions: baseCase.assessment.reflectionQuestions,
        retryable: false,
      });
    }
  });

  it('validates met, partial, and missed evidence contracts', () => {
    const invalid = rawFor(baseCase);
    invalid.domains[0].status = 'partial';
    invalid.domains[0].gap = null;
    assert.throws(() => normalizeFeedbackResult(invalid, baseCase), /gap/);
    const valid = rawFor(baseCase);
    valid.domains[1].status = 'partial';
    assert.equal(normalizeFeedbackResult(valid, baseCase).domains[1].status, 'partial');
  });

  it('keeps the universal prompt concise and explicit about safety and grading', () => {
    const prompt = loadFeedbackSystemPrompt();
    assert.match(prompt, /met.*partial.*missed/is);
    assert.match(prompt, /unsafe or incorrect advice/i);
    assert.match(prompt, /Do not output scores, percentages, points/i);
    const message = buildFeedbackUserMessage({ caseConfig: baseCase, turns, startedAt: 'a', endedAt: 'b' });
    assert.match(message, /assessment_context|transcript/);
  });
});
