import socket, subprocess, sys, os

HOST = "0.0.0.0"
PORT = 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(ROOT, "server")
PYTHON = os.path.join(SERVER_DIR, ".venv", "Scripts", "python.exe")

def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0

def main():
    if port_in_use(PORT):
        print(f"Port {PORT} is already in use.")
        print("Run stop.bat first, or close the existing server window.")
        input("Press Enter to exit...")
        sys.exit(1)

    print(f"Starting Brass: Lancashire server on {HOST}:{PORT}")
    subprocess.run(
        [PYTHON, "-m", "uvicorn", "app.main:app", "--host", HOST, "--port", str(PORT)],
        cwd=SERVER_DIR,
    )

if __name__ == "__main__":
    main()
