function pushFact(facts, id, text) {
  if (typeof text === 'string' && text.trim()) facts.push({ id, text: text.trim() });
}

/** Build stable IDs for facts that the patient may disclose during a session. */
export function toPatientFactCatalog(caseConfig) {
  const facts = [];
  const patient = caseConfig.patient;
  for (const [index, value] of (patient.background ?? []).entries()) {
    pushFact(facts, `patient.background.${index}`, value);
  }
  for (const [group, values] of Object.entries(patient.clinical ?? {})) {
    if (group === 'unknownFacts' || !Array.isArray(values)) continue;
    values.forEach((value, index) => pushFact(facts, `patient.clinical.${group}.${index}`, value));
  }
  for (const domain of caseConfig.consultation.domains) {
    const context = domain.patientContext;
    for (const field of ['facts', 'concerns', 'barriers', 'beliefsAndQuestions']) {
      context[field].forEach((value, index) => pushFact(facts, `${domain.id}.${field}.${index}`, value));
    }
  }
  return facts;
}

function tagFacts(values, prefix) {
  return values.map((text, index) => ({ id: `${prefix}.${index}`, text }));
}

function patientContextWithFactIds(caseConfig) {
  const patient = structuredClone(caseConfig.patient);
  patient.background = tagFacts(patient.background, 'patient.background');
  for (const [group, values] of Object.entries(patient.clinical)) {
    if (group !== 'unknownFacts' && Array.isArray(values)) {
      patient.clinical[group] = tagFacts(values, `patient.clinical.${group}`);
    }
  }
  return patient;
}

function domainsWithFactIds(caseConfig) {
  return caseConfig.consultation.domains.map(({ id, label, patientContext }) => {
    const context = structuredClone(patientContext);
    for (const field of ['facts', 'concerns', 'barriers', 'beliefsAndQuestions']) {
      context[field] = tagFacts(context[field], `${id}.${field}`);
    }
    return { id, label, patientContext: context };
  });
}

/** Build the minimum authoritative context needed for one patient turn. */
export function toPatientContext(caseConfig, { revealedFactIds = [] } = {}) {
  const factCatalog = toPatientFactCatalog(caseConfig);
  const revealed = new Set(Array.isArray(revealedFactIds) ? revealedFactIds : []);
  const domains = domainsWithFactIds(caseConfig);
  return {
    meta: {
      language: caseConfig.meta.language,
      revision: caseConfig.meta.revision,
    },
    patient: patientContextWithFactIds(caseConfig),
    opening: structuredClone(caseConfig.consultation.opening),
    domains,
    safety: structuredClone(caseConfig.safety),
    responseLimits: structuredClone(caseConfig.runtime.responseLimits),
    revealedFacts: factCatalog.filter((fact) => revealed.has(fact.id)),
  };
}

/** Build the minimum authoritative context needed for post-session assessment. */
export function toFeedbackContext(caseConfig) {
  return {
    meta: structuredClone(caseConfig.meta),
    patient: structuredClone(caseConfig.patient),
    domains: structuredClone(caseConfig.consultation.domains),
    safety: structuredClone(caseConfig.safety),
    communicationSkills: structuredClone(caseConfig.assessment.communicationSkills),
    reflectionQuestions: structuredClone(caseConfig.assessment.reflectionQuestions),
  };
}
