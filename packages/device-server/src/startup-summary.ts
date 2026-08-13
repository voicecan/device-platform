export type StartupSummaryInput = {
  adminUrl: string;
  deviceWsUrl: string;
  detailedLogPath: string | null;
  dataDirectory: string;
  setupTokenPath?: string;
  setupTokenSource?: string;
  showSetupTokenCommand?: string;
};

export function formatStartupSummary(input: StartupSummaryInput): string {
  const lines = [
    '',
    'Voicecan Device Server is ready',
    `  Admin:       ${input.adminUrl}`,
    `  Device WS:   ${input.deviceWsUrl}`,
    '  Console:     warnings and errors only',
    `  File logs:   ${input.detailedLogPath ?? 'disabled'}`,
  ];
  if (input.showSetupTokenCommand) {
    lines.push(
      '',
      'First-time setup is required',
      ...(input.setupTokenPath ? [`  Token file:   ${input.setupTokenPath}`] : []),
      ...(input.setupTokenSource ? [`  Token source: ${input.setupTokenSource}`] : []),
      `  Show token:   ${input.showSetupTokenCommand}`,
      `  Data dir:     ${input.dataDirectory}`,
      '',
      `Open ${input.adminUrl}, enter the setup_token, and create the first administrator.`,
      'The token is temporary and is removed after setup succeeds.',
    );
  } else {
    lines.push('  Setup:       complete');
  }
  return `${lines.join('\n')}\n`;
}
