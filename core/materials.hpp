// Typical properties of bar materials.
//
// Wood varies by 20% or more between boards, so these are starting points: the workshop page
// calibrates the model to your actual bar from a tap. E is the published bending stiffness along
// the grain. Wood's shear modulus is rarely published; about E/16 is typical for dense hardwoods
// along the grain, and the calibration corrects it.
#pragma once

namespace rt {

struct MaterialInfo {
  const char* id;
  const char* name;
  double E;     // Pa
  double G;     // Pa
  double rho;   // kg/m^3
  double loss;  // loss factor (sets how long the note rings)
  const char* source;
};

inline constexpr MaterialInfo MATERIALS[] = {
    {"rosewood", "Honduras rosewood", 22.0e9, 22.0e9 / 16, 1025, 0.0060,
     "The Wood Database (Dalbergia stevensonii): 1,025 kg/m3, 22.0 GPa"},
    {"bubinga", "Bubinga", 18.41e9, 18.41e9 / 16, 890, 0.0070, "The Wood Database (Guibourtia spp.): 890 kg/m3, 18.41 GPa"},
    {"padauk", "African padauk", 13.07e9, 13.07e9 / 16, 745, 0.0075,
     "The Wood Database (Pterocarpus soyauxii): 745 kg/m3, 13.07 GPa"},
    {"jarrah", "Jarrah (Australian)", 13.0e9, 13.0e9 / 16, 820, 0.0080, "WoodSolutions (Eucalyptus marginata), seasoned: 820 kg/m3, 13 GPa"},
    {"maple", "Hard maple", 12.62e9, 12.62e9 / 16, 705, 0.0080, "The Wood Database (Acer saccharum): 705 kg/m3, 12.62 GPa"},
    {"aluminium", "Aluminium 6061-T6", 68.9e9, 26.0e9, 2700, 0.0002, "ASM handbook values for 6061-T6: 2,700 kg/m3, 68.9 GPa, G 26 GPa"},
};

inline constexpr int MATERIAL_COUNT = sizeof(MATERIALS) / sizeof(MATERIALS[0]);

}  // namespace rt
