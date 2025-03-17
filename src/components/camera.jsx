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

    // Voice
    const [isListening, setIsListening] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const recognitionRef = useRef(null);
    const utteranceRef = useRef(null);

    // Initialize speech recognition
    useEffect(() => {
        if (!geminiEnabled) return;

        try {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (SpeechRecognition) {
                recognitionRef.current = new SpeechRecognition();
                recognitionRef.current.continuous = true;
                recognitionRef.current.interimResults = true;
                recognitionRef.current.lang = 'en-US';

                recognitionRef.current.onresult = async (event) => {
                    const transcript = Array.from(event.results)
                        .map(result => result[0].transcript)
                        .join('');

                    if (event.results[0].isFinal) {
                        await handleVoiceInput(transcript);
                    }
                };

                recognitionRef.current.onerror = (event) => {
                    console.error('Speech recognition error:', event.error);
                    setIsListening(false);
                };
            }
        } catch (error) {
            console.error('Failed to initialize speech recognition:', error);
        }
    }, [geminiEnabled]);

    // Initialize speech synthesis
    useEffect(() => {
        if (!geminiEnabled) return;

        try {
            const SpeechSynthesis = window.speechSynthesis;
            if (SpeechSynthesis) {
                utteranceRef.current = new SpeechSynthesisUtterance();
                utteranceRef.current.onend = () => setIsSpeaking(false);
            }
        } catch (error) {
            console.error('Failed to initialize speech synthesis:', error);
        }
    }, [geminiEnabled]);

    // Gemini frame processing
    useEffect(() => {
        if (!geminiEnabled || !isGeminiActive || !geminiSessionRef.current || !cameraReady) {
            return;
        }

        const frameRate = props.geminiFrameRate || 0.5;
        const frameDelay = 1000 / frameRate;

        let isFrameProcessingActive = true;
        let lastFrameContext = null;

        const processFrames = async () => {
            if (!isFrameProcessingActive || !geminiSessionRef.current) {
                return;
            }

            // Skip frame processing if we're currently speaking or listening
            if (isSpeaking || isListening) {
                if (isFrameProcessingActive) {
                    setTimeout(processFrames, frameDelay);
                }
                return;
            }

            try {
                const screenshot = webcamRef.current?.getScreenshot();
                if (screenshot) {
                    const base64Data = screenshot.split(",")[1];

                    if (base64Data !== lastFrameContext) {
                        lastFrameContext = base64Data;

                        // Send frame without expecting response
                        await geminiSessionRef.current.sendMessage([
                            {
                                inlineData: {
                                    mimeType: "image/jpeg",
                                    data: base64Data
                                }
                            },
                            {
                                text: "This is the current video frame. You are in monitoring mode. Do not respond unless specifically asked or if you detect an important event."
                            }
                        ]);
                    }
                }
            } catch (error) {
                console.error("Gemini frame processing error:", error);
            }

            if (isFrameProcessingActive) {
                setTimeout(processFrames, frameDelay);
            }
        };

        processFrames();

        return () => {
            isFrameProcessingActive = false;
        };
    }, [geminiEnabled, isGeminiActive, props.geminiFrameRate, cameraReady, isSpeaking, isListening]);

    // Handle voice input
    const handleVoiceInput = async (transcript) => {
        if (!geminiSessionRef.current || isProcessing) return;

        setIsProcessing(true);
        try {
            // Cancel any ongoing speech when user starts speaking
            window.speechSynthesis.cancel();

            // Take a fresh screenshot for context
            const screenshot = webcamRef.current?.getScreenshot();
            let messageParts = [{ text: transcript }];

            if (screenshot) {
                const base64Data = screenshot.split(",")[1];
                messageParts = [
                    {
                        inlineData: {
                            mimeType: "image/jpeg",
                            data: base64Data
                        }
                    },
                    { text: transcript }
                ];
            }

            const result = await geminiSessionRef.current.sendMessage(messageParts);
            const response = await result.response;
            const text = response.text();

            if (text) {
                setGeminiResponse(text);
                if (props.onGeminiResponse) {
                    props.onGeminiResponse(text);
                }
                // Wait a short moment before speaking to ensure the user has finished
                setTimeout(() => {
                    speakResponse(text);
                }, 500);
            }
        } catch (error) {
            console.error("Error processing voice input:", error);
            speakResponse("Sorry, I encountered an error processing your request.");
        } finally {
            setIsProcessing(false);
        }
    };

    // Speak response
    const speakResponse = (text) => {
        if (!utteranceRef.current) return;

        // Cancel any ongoing speech
        window.speechSynthesis.cancel();

        setIsSpeaking(true);
        utteranceRef.current.text = text;
        utteranceRef.current.onend = () => {
            setIsSpeaking(false);
            // Resume frame processing after speaking is done
            if (isGeminiActive && !isListening) {
                processFrames();
            }
        };

        // Add interruption handling
        utteranceRef.current.onpause = () => {
            setIsSpeaking(false);
            window.speechSynthesis.cancel();
        };

        window.speechSynthesis.speak(utteranceRef.current);
    };

    // Toggle voice input
    const toggleVoiceInput = () => {
        if (!recognitionRef.current) return;

        if (isListening) {
            recognitionRef.current.stop();
            // Resume frame processing after stopping listening
            if (isGeminiActive && !isSpeaking) {
                processFrames();
            }
        } else {
            // Stop any ongoing speech before starting to listen
            window.speechSynthesis.cancel();
            recognitionRef.current.start();
        }
        setIsListening(!isListening);
    };

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
                                "You are a helpful AI assistant that can analyze video and engage in conversation. You can be interrupted at any time by the user."
                        }
                    ]
                },
                generationConfig: {
                    maxOutputTokens: 500
                },
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: "Kore"
                        }
                    }
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
            if (!cameraReady) return;
            setIsGeminiActive(false);
            geminiSessionRef.current = null;
        };
    }, [geminiEnabled, cameraReady, props.geminiApiKey, props.geminiInitialPrompt]);

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
                    <div className="gemini-controls">
                        <button
                            onClick={toggleVoiceInput}
                            className={`gemini-button ${isListening ? "danger" : "primary"}`}
                        >
                            {isListening ? "Stop Listening" : "Start Listening"}
                        </button>
                        <button
                            onClick={() => {
                                setIsGeminiActive(false);
                                if (recognitionRef.current) {
                                    recognitionRef.current.stop();
                                }
                                window.speechSynthesis.cancel();
                            }}
                            className="gemini-button danger"
                        >
                            Stop
                        </button>
                    </div>
                )}

                {isListening && (
                    <div className="gemini-status">
                        Listening... Speak now
                    </div>
                )}

                {isSpeaking && (
                    <div className="gemini-status">
                        Speaking...
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
