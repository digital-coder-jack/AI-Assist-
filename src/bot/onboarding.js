'use strict';

const crypto = require('node:crypto');

const capturedOnboarding = new Map();

function iso(value) { return value instanceof Date ? value.toISOString() : value || null; }
function safeAvatar(member) { return { member_hash: member.avatar || null, user_hash: member.user?.avatar || null, member_url: typeof member.avatarURL === 'function' ? member.avatarURL() : null, user_url: typeof member.user?.displayAvatarURL === 'function' ? member.user.displayAvatarURL() : null }; }
function rolesFor(member) {
  const roles = [];
  const everyone = member.guild?.roles?.everyone;
  if (everyone) roles.push({ role_id: everyone.id, role_name: everyone.name, is_everyone: true });
  for (const role of member.roles?.cache?.values?.() || []) {
    if (role.id !== member.guild?.id) roles.push({ role_id: role.id, role_name: role.name, is_everyone: false });
  }
  return roles;
}
function promptData(onboarding) {
  if (!onboarding?.prompts) return { status: 'unavailable', prompts: [] };
  return { status: 'available_configuration_only', prompts: [...onboarding.prompts.values()].map(prompt => ({ question_id: prompt.id, question: prompt.title || null, type: prompt.type || null, required: prompt.required ?? null, in_onboarding: prompt.inOnboarding ?? null, options: [...(prompt.options?.values?.() || [])].map(option => ({ option_id: option.id, option: option.title || null, description: option.description || null })) })) };
}
async function getOnboarding(guild) {
  if (!guild) return null;
  if (guild.onboarding) return guild.onboarding;
  if (typeof guild.fetchOnboarding !== 'function') return null;
  try { return await guild.fetchOnboarding(); } catch { return null; }
}
async function buildOnboardingEvent(member, eventType = 'MEMBER_ONBOARDING', capturedAt = new Date()) {
  const guild = member.guild;
  const onboarding = await getOnboarding(guild);
  const prompts = promptData(onboarding);
  const actual = {
    type: 'MEMBER_ONBOARDING',
    recordType: eventType,
    discordUserId: member.user?.id || member.id,
    username: member.user?.username || null,
    globalName: member.user?.globalName || null,
    displayName: member.displayName || member.user?.displayName || null,
    avatar: safeAvatar(member),
    accountCreatedAt: iso(member.user?.createdAt),
    guildId: guild?.id || null,
    guildName: guild?.name || null,
    joinedAt: iso(member.joinedAt),
    roles: rolesFor(member),
    onboarding: {
      completed: null,
      completedAt: null,
      completionStatus: 'unavailable_through_discord_bot_api',
      membershipScreeningPending: member.pending ?? null,
      prompts,
      selectedAnswers: { status: 'unavailable_through_discord_bot_api', answers: [] }
    },
    profile: {
      language: null,
      interests: null,
      activities: null,
      gender: null,
      status: 'unavailable_through_discord_bot_api'
    },
    memberFlags: member.flags?.bitfield ?? null,
    metadata: { capturedAt: capturedAt.toISOString(), source: 'discord_onboarding', discordJs: '14.16.3' }
  };
  const fingerprintPayload = { ...actual, metadata: { ...actual.metadata, capturedAt: null } };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('hex').slice(0, 16);
  actual.eventId = `member-onboarding:${actual.guildId || 'dm'}:${actual.discordUserId}:${eventType}:${fingerprint}`;
  return actual;
}
async function captureMemberOnboarding(member, { eventType = 'MEMBER_ONBOARDING', postArchive, env = process.env, logger = console } = {}) {
  if (!member?.user?.id || !member.guild?.id || typeof postArchive !== 'function') return { archived: false, skipped: 'invalid_member' };
  const event = await buildOnboardingEvent(member, eventType);
  const identity = `${event.guildId}:${event.discordUserId}:${event.recordType}`;
  if (capturedOnboarding.get(identity) === event.eventId) return { archived: false, skipped: 'duplicate_event', eventId: event.eventId };
  capturedOnboarding.set(identity, event.eventId);
  void postArchive(event, env, logger);
  return { archived: true, eventId: event.eventId };
}
function onboardingChanged(oldMember, newMember) {
  const snapshot = member => JSON.stringify({ username: member.user?.username || null, globalName: member.user?.globalName || null, displayName: member.displayName || null, avatar: member.avatar || null, pending: member.pending ?? null, flags: member.flags?.bitfield ?? null, roles: [...(member.roles?.cache?.keys?.() || [])].sort() });
  return snapshot(oldMember) !== snapshot(newMember);
}
function registerOnboardingHandlers(client, { postArchive, env = process.env, logger = console } = {}) {
  client.on('guildMemberAdd', member => { void captureMemberOnboarding(member, { postArchive, env, logger, eventType: 'MEMBER_ONBOARDING' }); });
  client.on('guildMemberUpdate', (oldMember, newMember) => { if (onboardingChanged(oldMember, newMember)) void captureMemberOnboarding(newMember, { postArchive, env, logger, eventType: 'MEMBER_ONBOARDING_UPDATED' }); });
  return client;
}
function resetOnboardingForTests() { capturedOnboarding.clear(); }
module.exports = { buildOnboardingEvent, captureMemberOnboarding, onboardingChanged, registerOnboardingHandlers, rolesFor, promptData, resetOnboardingForTests };
