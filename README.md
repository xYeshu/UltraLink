# ⚡ UltraLink

UltraLink is a pure JavaScript and Web Audio API implementation of a data-over-audio communication system. It allows two devices running a web browser to transmit and receive short text messages through the air using high-frequency sound, effectively turning their speakers and microphones into a modem.

## Features

- **Browser-to-Browser Communication**: No native apps required; works entirely within standard modern web browsers.
- **Air-Gapped Data Transfer**: Send text across physical space without Wi-Fi, Bluetooth, or cables.
- **Pure JavaScript**: No external dependencies or native plugins.
- **Inaudible Frequencies**: Operates near the upper limit of human hearing (18.5kHz - 19.5kHz).
- **FSK Modulation**: Uses Frequency-Shift Keying for reliable binary data encoding.
- **Modern UI**: Sleek, glassmorphic design for a premium user experience.

## How It Works

UltraLink uses **Frequency-Shift Keying (FSK)** to encode binary data. A `0` is represented by a tone at **18500 Hz** and a `1` is represented by a tone at **19500 Hz**. These near-ultrasonic frequencies are at the edge of human hearing, making the transmission relatively unobtrusive.

1. **Sender**: The sender converts text into binary, applies error correction (Hamming code) and framing, then generates a continuous audio stream of FSK tones using the Web Audio API's `OscillatorNode`.
2. **Receiver**: The receiver uses the Web Audio API's `AnalyserNode` to capture microphone input, performs a Fast Fourier Transform (FFT) to detect the presence of the specific frequencies, demodulates the FSK signal back into binary, and decodes the original text.

## Usage

1. Open the application on two different devices.
2. On the **sending** device, navigate to the **SENDER** mode.
3. On the **receiving** device, navigate to the **RECEIVER** mode.
4. Ensure the devices are within earshot (a few feet apart in a quiet room is ideal).
5. Type a message in the sender and press "SEND". The receiver should pick up the tones and decode the message!

## License

ISC License.
