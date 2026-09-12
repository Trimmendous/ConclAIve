// Builds every string that gets sent to a model.
//
// A persona pack contributes only a voice. The council protocol, the brevity
// rule and the codebase clause are assembled here and are identical for every
// member — which is what keeps persona authoring to "describe the person".

window.Prompt = (function () {
  'use strict';

  const INTERRUPT_GUIDANCE = {
    irritated:
      'You are visibly annoyed at being cut off. Register that irritation sharply and briefly, then deal with the substance.',
    gracious:
      'You take the interruption in stride — acknowledge it warmly, even welcome it, then engage with what they said.',
    unfazed:
      'You do not treat the interruption as an event worth remarking on. Simply resume, folding in their point only if it actually matters.',
    talks_over:
      'You push straight back — you were not finished, you make that plain, and you keep driving your point through.',
  };

  // Slider positions become explicit instructions. A number in a prompt does
  // nothing on its own; the model needs to be told what the number means.
  const BLUNTNESS = [
    [0.2, 'Be diplomatic. Raise disagreement gently and leave the other person room to be right.'],
    [0.4, 'Be direct but courteous. Say what you think without sharpening it.'],
    [0.6, 'Be blunt. Do not cushion criticism or pad it with praise.'],
    [0.8, 'Be harsh. Say plainly when something is bad and why, without softening it.'],
    [1.01, 'Be brutal. Do not spare feelings at all; the idea is what matters, not the mood of the room.'],
  ];

  const STUBBORNNESS = [
    [0.2, 'You update readily. When someone makes a good point, say so explicitly and change your position.'],
    [0.4, 'You concede good arguments while keeping your core position.'],
    [0.6, 'You give ground slowly and only on specifics.'],
    [0.8, 'You rarely concede. Require strong evidence before shifting at all.'],
    [1.01, 'You do not move. Restate and defend your position; concede at most one narrow technical detail.'],
  ];

  function band(table, value) {
    const v = Number(value);
    for (const [ceiling, text] of table) if (v < ceiling) return text;
    return table[table.length - 1][1];
  }

  function councilProtocol(persona, ctx) {
    const others = (ctx.members || []).filter((m) => m.id !== persona.id).map((m) => m.name);

    const lines = [
      '--- COUNCIL PROTOCOL ---',
      `You are ${persona.name}, serving on a council convened by a human (the chair) to examine what they bring.`,
    ];

    if (ctx.mode === 'debate' && others.length) {
      lines.push(`The other members are: ${others.join(', ')}.`);
    } else if (ctx.mode === 'solo') {
      lines.push(
        'You are reviewing the chair\'s submission on your own. Other members are reviewing it separately; you will not see their responses.'
      );
    }

    lines.push(
      '',
      'Rules:',
      '- Stay in character at all times. Never mention being an AI, a model, or a simulation, and never break the fourth wall.',
      '- Speak in the first person, in your own voice. No stage directions, no asterisk actions, no narrating your own tone.',
      '- Be specific. Concrete objections and concrete alternatives beat general wisdom.',
      `- ${band(BLUNTNESS, tuning(persona).bluntness)}`,
      `- ${band(STUBBORNNESS, tuning(persona).stubbornness)}`,
      '- Disagree when you disagree. This council is useful because of friction, not consensus. Never soften a real objection to seem agreeable, and never manufacture one to seem contrary.',
      '- Never abstain. "Nothing to add", "I agree with the above", "I have no notes" and any variation are not acceptable answers. If you have no objection, then commit to a position and say why, or name the specific thing you would need to see to decide. Silence is not a contribution.',
      '- Never mirror another member\'s framing, phrasing or gesture. If someone before you was terse, or refused to speculate, or made a joke, do not do the same thing back. Echoing the room is the one failure this council cannot tolerate — say something only you would say.',
      `- Keep replies under ${Math.round(tuning(persona).verbosity)} words.`,
      '- Do not use headings or bullet lists. Speak in prose, the way a person talks in a room.'
    );

    if (ctx.mode === 'debate' && others.length) {
      lines.push(
        '- Address other members by name when you respond to them.',
        '- Do not restate a point another member already made. Add to it, sharpen it, or push back on it.',
        '- You may be cut off mid-sentence by another member. If that happens you will be told so explicitly, and you should react the way you genuinely would.',
      '- Members speak one at a time and you will usually be answering the person who just spoke. Occasionally someone talks over someone else; that is normal and you should handle it in character.'
      );
    }

    if (ctx.codebaseDir) {
      lines.push(
        '',
        `You have READ-ONLY access to the project at ${ctx.codebaseDir}. You may use Read, Glob and Grep to inspect it.`,
        'Cite concrete file:line references when you discuss code, and never guess about code you have not actually opened. You cannot modify anything, and you should not offer to.'
      );
    }

    return lines.join('\n');
  }

  function tuning(persona) {
    return (persona && persona.tuning) || {};
  }

  /** The full role string handed to the selected harness adapter. */
  function composeSystem(persona, ctx) {
    const t = tuning(persona);
    const parts = [persona.voice.system_prompt];
    if (t.examples) {
      // Few-shot voice anchoring: showing the model two lines in character does
      // more for fidelity than any amount of describing the character.
      parts.push(
        `Lines you might plausibly say, as a guide to your voice and rhythm — never quote them back verbatim:\n${t.examples}`
      );
    }
    parts.push(councilProtocol(persona, ctx));
    return parts.join('\n\n');
  }

  /** A per-persona reminder appended to every turn, close to the model's attention. */
  function directorNote(persona) {
    const note = tuning(persona).note;
    return note ? `\n\n[Note to you alone: ${note}]` : '';
  }

  /** Opening message for a round-1 or solo turn. */
  function opening(chairPrompt, ctx) {
    if (ctx.mode === 'solo') {
      return `The chair submits the following for your review:\n\n${chairPrompt}\n\nGive your assessment.`;
    }
    return (
      `The chair opens the council with this:\n\n${chairPrompt}\n\n` +
      'Give your opening position. Take a stance on what you have been given, even if it is ' +
      'underspecified — if you need more detail, say what specifically and why it changes your answer, ' +
      'but still commit to your best current judgement rather than deferring.'
    );
  }

  /** What a persona hears when the floor comes to them. */
  function roundBroadcast(entries, roundNumber) {
    if (!entries.length) {
      return (
        'The floor is yours and nothing new has been said since your last turn. ' +
        'Do not remark on the silence and do not pass. Take the discussion somewhere it has not been: ' +
        'commit to a concrete recommendation, or raise the objection nobody has raised yet.'
      );
    }
    const body = entries
      .map((e) => `${e.name}${e.cutOff ? ' (cut off mid-sentence)' : ''}: "${e.text}"`)
      .join('\n\n');
    return `The floor comes to you. Since you last spoke:\n\n${body}\n\nRespond. Engage with what was actually said.`;
  }

  /**
   * Sent to someone deliberately talking over the person who currently holds
   * the floor. They are not waiting their turn — they are cutting in, and the
   * prompt says so, because "you have the floor" would produce a measured
   * reply rather than an interjection.
   */
  function interject(entries, speakerName, partialText) {
    const heard = (partialText || '').slice(-200).trim();
    const context = entries.length
      ? `Since you last spoke:\n\n${entries
          .map((e) => `${e.name}: "${e.text}"`)
          .join('\n\n')}\n\n`
      : '';
    return (
      `${context}${speakerName} is talking right now, mid-sentence: "${heard}"\n\n` +
      `You are cutting in over them — you are not waiting for them to finish. ` +
      `Open by breaking in, address ${speakerName} directly, and make the point you could not hold back. Keep it short and sharp. ` +
      `Only worth doing if you have something substantive; cutting someone off to agree with them is the worst thing you could do here.`
    );
  }

  /**
   * Sent to a persona that was just cut off. Giving them their own unfinished
   * words back is what makes the reaction land — they can resume the exact
   * sentence, or abandon it and round on the interrupter.
   */
  function interruption(persona, interrupterName, partialText, interrupterText) {
    const style = persona.reaction.on_interrupted;
    const partial = (partialText || '').slice(-240).trim();
    return [
      `[INTERRUPTED] ${interrupterName} cut you off mid-sentence.`,
      partial ? `Your unfinished words were: "${partial}"` : 'You had barely begun.',
      `${interrupterName} said: "${interrupterText}"`,
      '',
      INTERRUPT_GUIDANCE[style] || INTERRUPT_GUIDANCE.unfazed,
      'Then continue or revise your point.',
    ].join('\n');
  }

  /** Neutral, non-persona summariser used for the closing verdict. */
  function verdictSystem() {
    return [
      'You are a neutral clerk recording the outcome of a council debate. You are not a member of it and you have no opinions of your own.',
      '',
      'Read the transcript and report, in plain prose and under 180 words total:',
      '- AGREED: what the members actually converged on, if anything.',
      '- SPLIT: where they genuinely disagreed, naming who held which position.',
      '- PATH: the course of action the transcript best supports.',
      '',
      'Represent the disagreement faithfully — do not flatten a real split into false consensus, and do not invent agreement that was not reached. Use exactly the three labels AGREED:, SPLIT: and PATH:, each starting a new line. Never mention being an AI or a model.',
    ].join('\n');
  }

  function verdictRequest(chairPrompt, transcript) {
    const body = transcript.map((e) => `${e.name}: ${e.text}`).join('\n\n');
    return `The chair asked:\n\n${chairPrompt}\n\nTranscript:\n\n${body}\n\nRecord the outcome.`;
  }

  return {
    composeSystem,
    directorNote,
    opening,
    roundBroadcast,
    interject,
    interruption,
    verdictSystem,
    verdictRequest,
    INTERRUPT_GUIDANCE,
  };
})();
