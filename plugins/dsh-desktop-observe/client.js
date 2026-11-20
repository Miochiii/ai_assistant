// Harness client-module format; no bundler, dependencies, network or model work.
window.__ModuleLoader__.load({
  id: 'dsh-desktop-observe',
  factory: () => ({
    inject: ['sessions', 'commandUi'],
    apply(ctx) {
      // The host command returns successfully, but a fresh conversation may not
      // show its command timeline. Acknowledge this command through the composer
      // notice channel too; never fabricate an assistant/user message to show it.
      return ctx.on('command/executed', (sessionId, name, result) => {
        if (!['desktop-check', 'desktop-trial', 'desktop-offline'].includes(name) || !['success', 'error'].includes(result?.kind)
            || typeof result.text !== 'string' || !result.text.trim()) return;
        const scope = ctx.sessions.scope(sessionId);
        if (!scope) return;
        const conversation = scope.get('conversation');
        if (!conversation) return;
        conversation.input.for(scope).notify(result.kind === 'error' ? 'error' : 'info', result.text);
      });
    },
  }),
});
