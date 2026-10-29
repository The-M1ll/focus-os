const q = new URLSearchParams(location.search);
const platform = q.get('p') ?? 'this site';
const reason = q.get('r');
const text: Record<string, string> = {
  budget: `You have used today’s time budget for <b></b>.`,
  outside_hours: `<b></b> is only available during the hours you or your class allowed.`,
  blocked: `<b></b> is blocked by your class.`,
};
const why = document.getElementById('why')!;
why.innerHTML = text[reason ?? ''] ?? `<b></b> is currently unavailable.`;
why.querySelector('b')!.textContent = platform;
