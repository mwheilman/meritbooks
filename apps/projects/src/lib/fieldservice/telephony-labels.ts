/** Client-safe telephony names (no node:crypto), shared by the call-log screens and the server adapters. */
export type VoiceProvider = 'RINGCENTRAL' | 'DIALPAD' | 'TWILIO_VOICE';
export const VOICE_PROVIDERS: readonly VoiceProvider[] = ['RINGCENTRAL', 'DIALPAD', 'TWILIO_VOICE'];
export const PROVIDER_LABEL: Readonly<Record<VoiceProvider, string>> = { RINGCENTRAL: 'RingCentral', DIALPAD: 'Dialpad', TWILIO_VOICE: 'Twilio Voice' };
