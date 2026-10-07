/** OpenCode v2 stores an agent colour only as six-digit hex. */
const AGENT_HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const isAgentHexColor = (value: string): boolean => AGENT_HEX_COLOR.test(value);

