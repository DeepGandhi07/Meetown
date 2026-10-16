/** Promise wrapper for the acknowledgement-based Socket.IO request protocol. */
export function request(socket, event, data = {}) {
  return new Promise((resolve, reject) => {
    socket.emit(event, data, (response) => {
      if (!response?.ok) {
        reject(new Error(response?.error || `Request failed: ${event}`));
        return;
      }
      resolve(response.data);
    });
  });
}
