# Stamp Generation Module

This module provides APIs for creating and managing stamp templates, and generating custom stamps based on these templates.

## Features

- Create, retrieve, and delete stamp templates
- Upload background images for stamps
- Generate custom stamps with dynamic text elements

## API Endpoints

### Stamp Templates

- `POST /stamps/templates` - Create a new stamp template
- `GET /stamps/templates` - Get all stamp templates
- `GET /stamps/templates/:id` - Get a stamp template by ID or SKU
- `DELETE /stamps/templates/:id` - Delete a stamp template

### Background Images

- `POST /stamps/upload-background` - Upload a background image for stamp templates

### Stamp Generation

- `POST /stamps/generate` - Generate a stamp based on a template

## Usage Examples

### Creating a Stamp Template

```json
POST /stamps/templates

{
  "sku": "AD-101",
  "name": "The Family Address Stamp",
  "backgroundImagePath": "uploads/backgrounds/background-1.png",
  "textElements": [
    {
      "id": "family-name",
      "defaultValue": "The Ccccc Family",
      "fontFamily": "Script MT Bold",
      "fontSize": 24,
      "fontWeight": "bold",
      "position": {
        "x": 150,
        "y": 50,
        "textAlign": "center"
      }
    },
    {
      "id": "address-line1",
      "defaultValue": "XXX VALVERDE DRIVE",
      "fontFamily": "Arial",
      "fontSize": 12,
      "position": {
        "x": 150,
        "y": 80,
        "textAlign": "center"
      }
    },
    {
      "id": "address-line2",
      "defaultValue": "SOUTH SAN FRANCISCO, CA XXXXX",
      "fontFamily": "Arial",
      "fontSize": 12,
      "position": {
        "x": 150,
        "y": 100,
        "textAlign": "center"
      }
    }
  ],
  "description": "A classic family address stamp"
}
```

### Generating a Stamp

```json
POST /stamps/generate

{
  "templateId": "AD-101",
  "textElements": [
    {
      "id": "family-name",
      "value": "The Smith Family"
    },
    {
      "id": "address-line1",
      "value": "123 MAIN STREET"
    },
    {
      "id": "address-line2",
      "value": "SAN FRANCISCO, CA 94123"
    }
  ],
  "format": "png"
}
```

## Frontend Integration

The frontend can use a graphical tool to define text element positions and then send the position data in the following format:

```json
{
  "value": "Text content",
  "position": {
    "x": 100,
    "y": 50,
    "width": 200,
    "height": 30,
    "rotation": 0,
    "textAlign": "center"
  }
}
```

## Font Management

Custom fonts should be placed in the `assets/fonts` directory. The system will automatically register these fonts for use in stamp generation. 