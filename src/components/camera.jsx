import { createElement, useRef, useEffect, useState, Fragment } from "react";
import Webcam from "react-webcam";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

export function Camera(props) {
    const webcamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const [cameraReady, setCameraReady] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [prevStartRecording, setPrevStartRecording] = useState(false);
    const [cameraError, setCameraError] = useState(null);

    // Gemini
    const geminiEnabled = props.geminiEnabled === true;
    const geminiModelRef = useRef(null);
    const [geminiResponse, setGeminiResponse] = useState(props.geminiResponseOverride || "");
    const [isGeminiActive, setIsGeminiActive] = useState(props.geminiActiveOverride || false);
    const geminiSessionRef = useRef(null);
    const [userInput, setUserInput] = useState("");
    const [chatHistory, setChatHistory] = useState([]);
    const [isProcessing, setIsProcessing] = useState(false);

    // Gemini initialization
    useEffect(() => {
        if (!geminiEnabled) return;

        // Skip if camera isn't ready (for session creation) and if session already exists
        if (!cameraReady || geminiSessionRef.current) {
            return;
        }

        try {
            console.log("Initializing Gemini model");
            const genAI = new GoogleGenerativeAI(props.geminiApiKey);
            const model = genAI.getGenerativeModel({
                model: "gemini-1.5-flash-latest",
                generationConfig: {
                    maxOutputTokens: 500
                },
                safetySettings: [
                    {
                        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
                    }
                ]
            });
            geminiModelRef.current = model;
            console.log("Gemini live model initialized");

            console.log("Starting Gemini session");
            const chat = model.startChat({
                systemInstruction: {
                    parts: [
                        {
                            text:
                                props.geminiInitialPrompt ||
                                "You are a helpful AI assistant that can analyze video and engage in conversation."
                        }
                    ]
                },
                generationConfig: {
                    maxOutputTokens: 500
                }
            });

            geminiSessionRef.current = chat;
            setIsGeminiActive(true);
            console.log("Gemini live session started");
        } catch (error) {
            console.error("Failed to initialize Gemini:", error);
            setIsGeminiActive(false);
            geminiSessionRef.current = null;
        }

        return () => {
            if (!cameraReady) return; // Don't clean up if we're just initializing the model
            setIsGeminiActive(false);
            geminiSessionRef.current = null;
        };
    }, [geminiEnabled, cameraReady, props.geminiApiKey, props.geminiInitialPrompt]);

    // Gemini frame processing
    useEffect(() => {
        console.log("Gemini frame processing effect running with state:", {
            geminiEnabled,
            isGeminiActive,
            hasSession: !!geminiSessionRef.current,
            cameraReady
        });

        if (!geminiEnabled || !isGeminiActive || !geminiSessionRef.current || !cameraReady) {
            console.log("Skipping Gemini frame processing setup - conditions not met");
            return;
        }

        console.log("Setting up Gemini frame processing");

        // Calculate delay between frames based on frame rate
        const frameRate = props.geminiFrameRate || 0.5; // Default to 1 frame every 2 seconds
        const frameDelay = 1000 / frameRate;

        let isFrameProcessingActive = true;
        let lastFrameContext = null;

        // Process frames sequentially with proper timing between them
        const processFrames = async () => {
            // Stop if component unmounted or conditions no longer valid
            if (!isFrameProcessingActive || !geminiSessionRef.current) {
                return;
            }

            try {
                // Take screenshot
                const screenshot = webcamRef.current?.getScreenshot();
                if (screenshot) {
                    const base64Data = screenshot.split(",")[1];

                    // Only send frame if it's different from the last one
                    if (base64Data !== lastFrameContext) {
                        console.log("Sending new frame to Gemini for context...");
                        lastFrameContext = base64Data;

                        // Send to Gemini as context and handle response
                        const result = await geminiSessionRef.current.sendMessage([
                            {
                                inlineData: {
                                    mimeType: "image/jpeg",
                                    data: base64Data
                                }
                            },
                            {
                                text: "This is the current video frame. You are in monitoring mode. Do not describe what you see unless specifically asked or if it's relevant to your task. Only respond if you detect a specific event or condition that requires immediate action or communication. Do not send acknowledgments or status updates. Stay silent unless you need to take action."
                            }
                        ]);

                        const response = await result.response;
                        const text = response.text();

                        if (text && text.trim() !== "") {
                            console.log("Received meaningful response from Gemini:", text);
                            setChatHistory(prev => [...prev, { role: "assistant", content: text }]);
                            setGeminiResponse(text);
                            if (props.onGeminiResponse) {
                                props.onGeminiResponse(text);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error("Gemini frame processing error:", error);
            }

            // Schedule next frame with proper delay if still active
            if (isFrameProcessingActive) {
                setTimeout(processFrames, frameDelay);
            }
        };

        // Start the frame processing
        processFrames();

        // Cleanup function
        return () => {
            console.log("Cleaning up Gemini frame processing");
            isFrameProcessingActive = false;
        };
    }, [geminiEnabled, isGeminiActive, props.geminiFrameRate, cameraReady]);

    // Handle user input submission
    const handleUserSubmit = async e => {
        e.preventDefault();
        if (!userInput.trim() || !geminiSessionRef.current || isProcessing) return;

        setIsProcessing(true);
        const userMessage = userInput.trim();
        setUserInput("");
        setChatHistory(prev => [...prev, { role: "user", content: userMessage }]);

        try {
            // Take a fresh screenshot for context
            const screenshot = webcamRef.current?.getScreenshot();
            let messageParts = [{ text: userMessage }];

            if (screenshot) {
                const base64Data = screenshot.split(",")[1];
                messageParts = [
                    {
                        inlineData: {
                            mimeType: "image/jpeg",
                            data: base64Data
                        }
                    },
                    { text: userMessage }
                ];
            }

            const result = await geminiSessionRef.current.sendMessage(messageParts);
            const response = await result.response;
            const text = response.text();

            setChatHistory(prev => [...prev, { role: "assistant", content: text }]);
            setGeminiResponse(text);
            if (props.onGeminiResponse) {
                props.onGeminiResponse(text);
            }
        } catch (error) {
            console.error("Error sending message to Gemini:", error);
            const errorMessage = "Error: " + error.message;
            setChatHistory(prev => [...prev, { role: "assistant", content: errorMessage }]);
            setGeminiResponse(errorMessage);
        } finally {
            setIsProcessing(false);
        }
    };

    // Handle code-initiated messages
    useEffect(() => {
        if (!props.geminiMessage?.value || !geminiSessionRef.current || isProcessing) return;

        const sendMessage = async () => {
            setIsProcessing(true);
            try {
                // Take a fresh screenshot for context
                const screenshot = webcamRef.current?.getScreenshot();
                let messageParts = [{ text: props.geminiMessage.value }];

                if (screenshot) {
                    const base64Data = screenshot.split(",")[1];
                    messageParts = [
                        {
                            inlineData: {
                                mimeType: "image/jpeg",
                                data: base64Data
                            }
                        },
                        { text: props.geminiMessage.value }
                    ];
                }

                const result = await geminiSessionRef.current.sendMessage(messageParts);
                const response = await result.response;
                const text = response.text();

                setChatHistory(prev => [
                    ...prev,
                    { role: "system", content: props.geminiMessage.value },
                    { role: "assistant", content: text }
                ]);
                setGeminiResponse(text);
                if (props.onGeminiResponse) {
                    props.onGeminiResponse(text);
                }
            } catch (error) {
                console.error("Error sending system message to Gemini:", error);
                const errorMessage = "Error: " + error.message;
                setChatHistory(prev => [
                    ...prev,
                    { role: "system", content: props.geminiMessage.value },
                    { role: "assistant", content: errorMessage }
                ]);
                setGeminiResponse(errorMessage);
            } finally {
                setIsProcessing(false);
                props.geminiMessage.setValue(""); // Clear the message after processing
            }
        };

        sendMessage();
    }, [props.geminiMessage?.value]);

    // Gemini timeout if no response
    useEffect(() => {
        if (isGeminiActive && !geminiResponse) {
            const timeoutId = setTimeout(() => {
                console.log("Gemini response timeout");
                setGeminiResponse("No response received from Gemini. The API may be unavailable.");
            }, 15000); // 15 seconds timeout

            return () => {
                clearTimeout(timeoutId);
            };
        }
    }, [isGeminiActive, geminiResponse]);

    const handleUserMedia = () => {
        console.log("Camera stream initialized successfully");
        setCameraError(null);
        setCameraReady(true);
    };

    const handleCameraError = error => {
        console.error("Camera error:", error);
        setCameraError("Failed to access camera: " + error.message);
    };

    const startRecording = () => {
        if (webcamRef.current && webcamRef.current.stream) {
            const chunks = [];
            const mediaRecorder = new MediaRecorder(webcamRef.current.stream);
            mediaRecorderRef.current = mediaRecorder;
            mediaRecorder.ondataavailable = event => {
                if (event.data.size > 0) {
                    chunks.push(event.data);
                    if (mediaRecorder.state !== "recording") {
                        const videoBlob = new Blob(chunks, { type: "video/webm" });
                        const reader = new FileReader();
                        reader.readAsDataURL(videoBlob);
                        reader.onloadend = () => {
                            const base64String = reader.result.split(",")[1];
                            if (props.onRecordingComplete) {
                                props.onRecordingComplete(base64String);
                            }
                        };
                        setIsRecording(false);
                    }
                }
            };
            mediaRecorder.start();
            setIsRecording(true);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current) {
            mediaRecorderRef.current.stop();
        }
    };

    useEffect(() => {
        if (props.takeScreenshot.value === true && webcamRef.current) {
            const screenshot = webcamRef.current.getScreenshot();
            if (props.onScreenshot && screenshot) {
                props.takeScreenshot.setValue(false);
                const base64String = screenshot.split(",")[1];
                props.onScreenshot(base64String);
            }
        }
    }, [props.takeScreenshot, props.onScreenshot]);

    useEffect(() => {
        if (!props.startRecording) {
            return;
        }

        if (props.startRecording.value === true && !prevStartRecording) {
            startRecording();
        } else if (props.startRecording.value === false && prevStartRecording) {
            stopRecording();
        }
        setPrevStartRecording(props.startRecording.value);
    }, [props.startRecording?.value]);

    const videoConstraints = {
        facingMode: props.facingMode || "environment"
    };

    const renderGeminiResponse = () => {
        if (!geminiEnabled) return null;

        return (
            <div className="gemini-response">
                {!isGeminiActive && <div className="gemini-status">Gemini Live inactive</div>}

                {isGeminiActive && (
                    <div className="gemini-chat">
                        <div className="gemini-chat-history">
                            {chatHistory.map((message, index) => (
                                <div key={index} className={`gemini-message ${message.role}`}>
                                    <div className="gemini-avatar">
                                        {message.role === "user" ? "U" : message.role === "system" ? "S" : "G"}
                                    </div>
                                    <div className="gemini-message-content">{message.content}</div>
                                </div>
                            ))}
                        </div>

                        <form onSubmit={handleUserSubmit} className="gemini-input-form">
                            <input
                                type="text"
                                value={userInput}
                                onChange={e => setUserInput(e.target.value)}
                                placeholder="Ask a question..."
                                disabled={isProcessing}
                                className="gemini-input"
                            />
                            <button
                                type="submit"
                                disabled={isProcessing || !userInput.trim()}
                                className="gemini-button primary"
                            >
                                Send
                            </button>
                        </form>
                    </div>
                )}

                {props.showGeminiControls && (
                    <div className="gemini-controls">
                        <button
                            onClick={() => {
                                console.log("Clear button clicked");
                                setGeminiResponse("");
                                setChatHistory([]);
                                if (props.onGeminiResponse) {
                                    props.onGeminiResponse("");
                                }
                            }}
                            className="gemini-button"
                        >
                            Clear
                        </button>
                        <button
                            onClick={() => {
                                console.log("Toggle button clicked, current state:", isGeminiActive);
                                const newState = !isGeminiActive;
                                setIsGeminiActive(newState);

                                if (newState && geminiModelRef.current && !geminiSessionRef.current) {
                                    console.log("Restarting Gemini session");
                                    const startGeminiLiveSession = async () => {
                                        try {
                                            const chat = geminiModelRef.current.startChat({
                                                systemInstruction: {
                                                    parts: [
                                                        {
                                                            text:
                                                                props.geminiInitialPrompt ||
                                                                "You are a helpful AI assistant that can analyze video and engage in conversation."
                                                        }
                                                    ]
                                                },
                                                generationConfig: {
                                                    maxOutputTokens: 500
                                                }
                                            });
                                            geminiSessionRef.current = chat;
                                            console.log("Gemini session restarted successfully");
                                        } catch (error) {
                                            console.error("Failed to restart Gemini session:", error);
                                            setGeminiResponse("Failed to start Gemini: " + error.message);
                                        }
                                    };
                                    startGeminiLiveSession();
                                }
                            }}
                            className={`gemini-button ${isGeminiActive ? "danger" : "primary"}`}
                        >
                            {isGeminiActive ? "Pause" : "Resume"}
                        </button>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className={"mx-camerastream " + props.classNames} style={{ width: props.width, height: props.height }}>
            {cameraError ? (
                <div
                    className="camera-error"
                    style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "#000",
                        color: "#fff",
                        padding: "20px",
                        textAlign: "center"
                    }}
                >
                    {cameraError}
                </div>
            ) : (
                <Webcam
                    ref={webcamRef}
                    screenshotFormat="image/jpeg"
                    audio={props.audioEnabled}
                    videoConstraints={videoConstraints}
                    onUserMedia={handleUserMedia}
                    onUserMediaError={handleCameraError}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
            )}

            {geminiEnabled && renderGeminiResponse()}

            {!cameraReady && !cameraError && props.loadingContent && (
                <div
                    className="camera-loading"
                    style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "rgba(0,0,0,0.5)",
                        color: "#fff"
                    }}
                >
                    {props.loadingContent}
                </div>
            )}

            {props.showRecordingIndicator && isRecording && (
                <div className="camera-recording-indicator">
                    <span className="recording-dot"></span> Recording
                </div>
            )}

            {cameraReady && (
                <Fragment>
                    {props.contentTop && (
                        <div className="camera-content-overlay camera-align-top">{props.contentTop}</div>
                    )}
                    {props.contentMiddle && (
                        <div className="camera-content-overlay camera-align-middle">{props.contentMiddle}</div>
                    )}
                    {props.contentBottom && (
                        <div className="camera-content-overlay camera-align-bottom">{props.contentBottom}</div>
                    )}
                </Fragment>
            )}
        </div>
    );
}
