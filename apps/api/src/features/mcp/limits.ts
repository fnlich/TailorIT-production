// v2.0 P5 (04-accounts-limits.md §3, 07-mcp.md "Server-side enforcement, per tool"): the resume storage limit on the
// MCP path, checked by the server before anything is made or saved, whatever the person's AI or their custom
// instructions say: P6a's checks, the same as every other path's (features/resumes/repository.ts).
export { assertRoomForResumes, assertResumeEditable } from '../resumes/repository';
