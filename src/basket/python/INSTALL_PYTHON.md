# Basket Order Generator Python Dependencies

This document explains how to set up the Python environment for the basket order generator.

## Prerequisites

- Python 3.7+ installed on your system
- pip (Python package manager)

## Installation Steps

1. Create a virtual environment (recommended):

```bash
cd src/basket/python
python3 -m venv .venv
```

2. Activate the virtual environment:

- On macOS/Linux:
```bash
source .venv/bin/activate
```

- On Windows:
```bash
.venv\Scripts\activate
```

3. Install the required packages:

```bash
pip install -r requirements.txt
```

## Verifying Installation

To verify that everything is installed correctly, you can try importing the packages in Python:

```python
import pandas
import pptx
```

If no errors occur, the installation was successful.

## Troubleshooting

If you encounter issues with the python-pptx package, you may need to install additional system dependencies:

- On Ubuntu/Debian:
```bash
sudo apt-get install python3-dev
```

- On macOS:
```bash
brew install freetype
```

For any other issues, please check the error messages and consult the respective package documentation. 