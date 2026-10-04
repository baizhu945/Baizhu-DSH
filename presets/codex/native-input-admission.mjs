/**
 * Trusted native-preset proof, not a client option or a capability catalog.
 * Provide under the agent preset's `codexNativeInputAdmission` isolation label;
 * that label must be inherited by agent.ctx and withdrawn with the preset.
 * Never provide on the host/root scope: the API deliberately rejects that case.
 * Native core owns model admission; DSH still owns bytes, media, receipts and FS.
 */
export const codexNativeInputAdmission = Object.freeze({ usesNativeModelAdmission: true })
