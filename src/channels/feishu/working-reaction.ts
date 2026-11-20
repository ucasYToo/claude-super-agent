export interface ReactionApi {
  create(input: {
    path: { message_id: string };
    data: { reaction_type: { emoji_type: string } };
  }): Promise<{ code?: number; data?: { reaction_id?: string } }>;
  delete(input: { path: { message_id: string; reaction_id: string } }): Promise<{ code?: number }>;
}

// Start the API call now. A slow reaction must never hold up the message or its reply.
export function markWorking(api: ReactionApi, messageId: string): () => void {
  async function add() {
    const response = await api.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: "Typing" } },
    });
    if (response.code) throw Error(String(response.code));
    return response.data?.reaction_id;
  }

  const reaction = add().catch(() => {
    console.warn("飞书处理中表情添加失败，请检查机器人消息表情权限");
    return undefined;
  });
  return () => {
    void reaction
      .then(async (id) => {
        if (!id) return;
        const response = await api.delete({ path: { message_id: messageId, reaction_id: id } });
        if (response.code) throw Error(String(response.code));
      })
      .catch(() => console.warn("飞书处理中表情移除失败"));
  };
}
