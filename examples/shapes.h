#pragma once
#include <cstdint>

namespace geo {

// Перечисление в заголовке: CppForge найдёт его и из demo.cpp.
enum class ShapeKind : std::uint8_t {
    Circle,
    Square,
    Triangle,
    Polygon = 10,
    Default = Circle,   // синоним — отдельный case не нужен
};

} // namespace geo
