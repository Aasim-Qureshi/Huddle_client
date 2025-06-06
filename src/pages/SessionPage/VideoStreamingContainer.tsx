import { useEffect, useRef, useState } from "react";
import VideoStream from "../../components/VideoStream";
import { ColFlex } from "../../styles/utils/flexUtils";
import { IStreamOptions } from "../../types/IStreamOptions";
import { useResponsive } from "../../hooks/useResponsive";

// Using Google's STUN server
const ICE_SERVERS = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

interface MemberDetail {
  id: string;
  name: string;
}

interface IUserOptions {
  hasLeft: boolean;
}

interface VideoStreamingContainerProps {
  memberDetails: MemberDetail[];
  userOptions: IUserOptions;
  socket: any;
  room: any;
  user: any;
  streamOptions: IStreamOptions;
}

interface RemoteStatus {
  muted: boolean;
  videoOn: boolean;
}

function VideoStreamingContainer({
  memberDetails,
  userOptions,
  socket,
  room,
  user,
  streamOptions,
}: VideoStreamingContainerProps) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<{
    [key: string]: MediaStream;
  }>({});
  // Remote status mapping for each user id
  const [remoteStatus, setRemoteStatus] = useState<{
    [key: string]: RemoteStatus;
  }>({});
  const peerConnections = useRef<{ [key: string]: RTCPeerConnection }>({});

  const { category } = useResponsive();

  // Get local video/audio stream (only once)
  useEffect(() => {
    const getLocalStream = async () => {
      try {
        const userStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        setLocalStream(userStream);
      } catch (err) {
        console.error("Error accessing webcam:", err);
      }
    };

    getLocalStream();

    return () => {
      Object.values(peerConnections.current).forEach((pc) => pc.close());
      localStream?.getTracks().forEach((track) => track.stop());
    };
    // get stream only once on mount
  }, []);

  // Update local tracks' enabled state when streamOptions change.
  useEffect(() => {
    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = streamOptions.audio;
      });
      localStream.getVideoTracks().forEach((track) => {
        track.enabled = streamOptions.video;
      });
      // Optionally, you could emit your own mute/video status when changed:
      socket.emit("mute-status", {
        roomId: room.id,
        userId: user.id,
        muted: !streamOptions.audio,
      });
      socket.emit("video-status", {
        roomId: room.id,
        userId: user.id,
        videoOn: streamOptions.video,
      });
    }
  }, [streamOptions, localStream, socket, room, user]);

  // Listen for signaling messages from the socket (offer/answer/ice-candidate)
  useEffect(() => {
    if (!socket || !localStream || !room || !user) return;

    socket.on("offer", async ({ senderId, sdp }: any) => {
      if (senderId === user.id) return;
      let pc = peerConnections.current[senderId];
      if (!pc) {
        pc = new RTCPeerConnection(ICE_SERVERS);
        peerConnections.current[senderId] = pc;
        localStream
          .getTracks()
          .forEach((track) => pc.addTrack(track, localStream));
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit("ice-candidate", {
              roomId: room.id,
              senderId: user.id,
              receiverId: senderId,
              candidate: event.candidate,
            });
          }
        };
        pc.ontrack = (event) => {
          setRemoteStreams((prev) => ({
            ...prev,
            [senderId]: event.streams[0],
          }));
        };
      }
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", {
        roomId: room.id,
        senderId: user.id,
        receiverId: senderId,
        sdp: answer,
      });
    });

    socket.on("answer", async ({ senderId, sdp }: any) => {
      const pc = peerConnections.current[senderId];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      }
    });

    socket.on("ice-candidate", async ({ senderId, candidate }: any) => {
      const pc = peerConnections.current[senderId];
      if (pc && candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    return () => {
      socket.off("offer");
      socket.off("answer");
      socket.off("ice-candidate");
    };
  }, [socket, localStream, room, user]);

  // Listen for remote mute and video status updates
  useEffect(() => {
    if (!socket) return;
    socket.on("mute-status", ({ userId, muted }: any) => {
      setRemoteStatus((prev) => ({
        ...prev,
        [userId]: { ...(prev[userId] || { videoOn: true }), muted },
      }));
    });
    socket.on("video-status", ({ userId, videoOn }: any) => {
      setRemoteStatus((prev) => ({
        ...prev,
        [userId]: { ...(prev[userId] || { muted: false }), videoOn },
      }));
    });
    return () => {
      socket.off("mute-status");
      socket.off("video-status");
    };
  }, [socket]);

  // Create peer connections for new members and send offers
  useEffect(() => {
    if (!localStream || !socket || !room || !user) return;
    memberDetails.forEach((member) => {
      if (member.id !== user.id && !peerConnections.current[member.id]) {
        const pc = new RTCPeerConnection(ICE_SERVERS);
        peerConnections.current[member.id] = pc;
        localStream
          .getTracks()
          .forEach((track) => pc.addTrack(track, localStream));
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit("ice-candidate", {
              roomId: room.id,
              senderId: user.id,
              receiverId: member.id,
              candidate: event.candidate,
            });
          }
        };
        pc.ontrack = (event) => {
          setRemoteStreams((prev) => ({
            ...prev,
            [member.id]: event.streams[0],
          }));
        };
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => {
            socket.emit("offer", {
              roomId: room.id,
              senderId: user.id,
              receiverId: member.id,
              sdp: pc.localDescription,
            });
          })
          .catch(console.error);
      }
    });

    return () => {
      memberDetails.forEach((member) => {
        if (peerConnections.current[member.id]) {
          peerConnections.current[member.id].close();
          delete peerConnections.current[member.id];
        }
      });
    };
  }, [memberDetails, localStream, socket, room, user]);

  // when user leaves
  useEffect(() => {
    if (userOptions.hasLeft) {
      Object.values(peerConnections.current).forEach((pc) => pc.close());
      peerConnections.current = {}; // Clear peer connections

      localStream?.getVideoTracks()[0].stop();
      setLocalStream(null);
      setRemoteStreams({});
      setRemoteStatus({});
    }
  }, [userOptions.hasLeft]);

  return (
    <div
      style={{
        ...ColFlex,
        width: category == "xs" ? "100%" : "30%",
        height: category == "xs" ? "75%" : "100%",
        justifyContent: "flex-start",
        border: "2px solid grey",
        borderRadius: "12.5px",
        padding: category == "xs" ? "20px" :"10px",
        gap: category == "xs" ? "20px" :"10px",
        overflowY: "scroll",
        scrollbarWidth: "thin",
      }}
    >
      {/* Local Video */}
      {localStream && (
        <VideoStream
          userName="You"
          stream={localStream}
          // For local stream, you can control status directly from streamOptions
          isMuted={!streamOptions.audio}
          isCameraOn={streamOptions.video}
        />
      )}
      {/* Remote Videos */}
      {memberDetails
        .filter((member) => member.id !== user.id)
        .map((member) => (
          <VideoStream
            key={member.id}
            userName={member.name}
            stream={remoteStreams[member.id] || null}
            isMuted={remoteStatus[member.id]?.muted ?? false}
            isCameraOn={remoteStatus[member.id]?.videoOn ?? true}
          />
        ))}
    </div>
  );
}

export default VideoStreamingContainer;
