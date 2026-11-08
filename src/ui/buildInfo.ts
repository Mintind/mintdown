declare const __MINTDOWN_BUILD_INFO__: {
  version: string; revision: string; dirty: boolean | null; sourceSha256: string;
  channel: string; mode: string; builtAt: string; id: string;
};

export const buildInfo = __MINTDOWN_BUILD_INFO__;
export function buildDescription(): string {
  return `Mintdown ${buildInfo.version}\n构建：${buildInfo.id}\nGit：${buildInfo.revision}${buildInfo.dirty ? '（含未提交改动）' : ''}\n源码 SHA-256：${buildInfo.sourceSha256}\n渠道：${buildInfo.channel} / ${buildInfo.mode}\n构建/开发启动时间：${buildInfo.builtAt}`;
}
