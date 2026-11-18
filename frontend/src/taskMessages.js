export function updateTaskInMessages(messages, task) {
  return messages.map((message) => {
    if (!message.tasks?.some((attached) => attached.id === task.id)) return message;
    return {
      ...message,
      tasks: message.tasks.map((attached) => attached.id === task.id ? task : attached),
    };
  });
}

export function removeTaskFromMessages(messages, taskId) {
  return messages.map((message) => {
    if (!message.tasks?.some((attached) => attached.id === taskId)) return message;
    return {
      ...message,
      tasks: message.tasks.filter((attached) => attached.id !== taskId),
    };
  });
}

export function reconcileTaskMessages(messages, tasks) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return messages.map((message) => {
    if (!message.tasks?.length) return message;
    const attachments = message.tasks
      .filter((attached) => tasksById.has(attached.id))
      .map((attached) => tasksById.get(attached.id));
    if (attachments.length === message.tasks.length &&
        attachments.every((attached, index) => attached === message.tasks[index])) {
      return message;
    }
    return { ...message, tasks: attachments };
  });
}
